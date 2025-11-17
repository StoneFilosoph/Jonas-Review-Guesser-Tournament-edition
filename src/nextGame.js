(function (root) {
  const ns = (root.ReviewGuesser = root.ReviewGuesser || {});

  // ---------------------------------------------------------------------------
  // CSV loading + caching
  // ---------------------------------------------------------------------------

	// All batch files used for "Smart Random"
	const BATCH_FILES = [
		"data/Batch_1.csv",
		"data/Batch_2.csv",
		"data/Batch_3.csv",
		"data/Batch_4.csv",
		"data/Batch_5.csv",
		"data/Batch_6.csv"
	];

	// Very small, editable list of tags we want to avoid.
	// All checks are done in lowercase.
	const BANNED_TAGS = [
		"nsfw",
		"sexual content",
		"nudity",
		"adult only",
		"hentai"
	];

	let lastAutoSkippedAppId = null;

	/**
	 * Small helper to send structured debug info into localStorage
	 * via ns.debugLog (if available). This survives navigation and
	 * makes it easier to debug NSFW page scanning.
	 *
	 * @param {string} topic
	 * @param {any} payload
	 */
	function debug(topic, payload) {
		if (ns.debugLog) {
			ns.debugLog(topic, payload);
		}
	}

	// Simple in-memory cache: path -> Promise<number[]>
	const CSV_CACHE = Object.create(null);

	/**
	 * Load a CSV file and parse it into an array of app IDs (numbers).
	 * Results are cached per-path so each file is only fetched once.
	 *
	 * @param {string} relativePath - e.g. "data/released_appids.csv"
	 * @returns {Promise<number[]>}
	 */
	function loadCsvIds(relativePath) {
		if (CSV_CACHE[relativePath]) {
			return CSV_CACHE[relativePath];
		}

		const url =
			typeof chrome !== "undefined" &&
			chrome.runtime &&
			chrome.runtime.getURL
				? chrome.runtime.getURL(relativePath)
				: relativePath;

		CSV_CACHE[relativePath] = fetch(url)
			.then((r) => {
				if (!r.ok) throw new Error("CSV fetch failed: " + r.status);
				return r.text();
			})
			.then((text) => {
				return text
					.split(/\r?\n/)
					.map((s) => s.trim())
					.filter((s) => /^\d+$/.test(s))
					.map((s) => parseInt(s, 10));
			})
			.catch((err) => {
				console.warn("[ext] failed to load CSV", relativePath, err);
				return [];
			});

		return CSV_CACHE[relativePath];
	}

	/**
	 * Existing behavior: full released app id list (for Pure Random).
	 *
	 * @returns {Promise<number[]>}
	 */
	async function getReleasedAppIds() {
		// NOTE: we assume you placed this file at data/released_appids.csv
		return loadCsvIds("data/released_appids.csv");
	}

	/**
	 * Helper to pick a random element from an array of app IDs.
	 * Uses seeded RNG for deterministic selection.
	 *
	 * @param {number[]} ids
	 * @returns {number|null}
	 */
	function pickRandomId(ids) {
		if (!ids || !ids.length) return null;
		const rng = ns.getRNG();
		return rng.pick(ids);
	}

	/**
	 * "Pure Random" strategy: pick from the global released_appids list.
	 *
	 * @returns {Promise<number|null>}
	 */
	async function getPureRandomAppId() {
		const ids = await getReleasedAppIds();
		return pickRandomId(ids);
	}

	/**
	 * "Smart Random" strategy:
	 *   - pick a random batch CSV (Batch_1..Batch_6)
	 *   - load IDs from that file
	 *   - pick a random app id from that batch
	 *   - if anything goes wrong / empty → fall back to Pure Random
	 *
	 * @returns {Promise<number|null>}
	 */
	async function getSmartRandomAppId() {
		if (!BATCH_FILES.length) return getPureRandomAppId();

		// Use seeded RNG for batch selection
		const rng = ns.getRNG();
		const file = rng.pick(BATCH_FILES);
		const ids = await loadCsvIds(file);
		const id = pickRandomId(ids);

		if (id != null) return id;

		// Fallback to Pure Random if this batch is empty or failed
		return getPureRandomAppId();
	}

	// ---------------------------------------------------------------------------
	// Tag fetching + simple NSFW filter
	// ---------------------------------------------------------------------------

	/**
	 * Fetch tags/genres/categories for a given appid from Steam's public API.
	 * Returns a lowercased list of tag-like strings.
	 *
	 * @param {number} appid
	 * @returns {Promise<string[]>}
	 */
	async function fetchAppTags(appid) {
		const url = `https://store.steampowered.com/api/appdetails?appids=${appid}&l=english&cc=us`;

		try {
            const res = await fetch(url, { credentials: "omit" });
			if (!res.ok) throw new Error(`tag fetch failed: ${res.status}`);
			const json = await res.json();

			const key = String(appid);
			const entry = json && json[key];
			const data = entry && entry.success && entry.data;
			if (!data) return [];

			const tags = [];

			if (Array.isArray(data.genres)) {
				for (const g of data.genres) {
					if (g && g.description) tags.push(g.description);
				}
			}

			if (Array.isArray(data.categories)) {
				for (const c of data.categories) {
					if (c && c.description) tags.push(c.description);
				}
			}

			// Some responses expose user / developer tags here
			if (data.tags && typeof data.tags === "object") {
				for (const k in data.tags) {
					if (Object.prototype.hasOwnProperty.call(data.tags, k)) {
						tags.push(k);
					}
				}
			}

			return Array.from(
				new Set(
					tags
						.filter(Boolean)
						.map((t) => String(t).toLowerCase().trim())
				)
			);
		} catch (err) {
			console.warn("[ext] failed to fetch tags for app", appid, err);
			return [];
		}
	}

	/**
	 * Check whether any of the given tags match (or contain) a banned tag.
	 *
	 * @param {string[]} tagsLower
	 * @returns {boolean}
	 */
	function hasBannedTag(tagsLower) {
		if (!tagsLower || !tagsLower.length) return false;

		for (const t of tagsLower) {
			for (const banned of BANNED_TAGS) {
				if (t.includes(banned)) return true;
			}
		}

		return false;
	}

	/**
	 * Check the current page's visible tag cloud for any banned tags/keywords.
	 *
	 * This is a defensive fallback: the main NSFW filtering is done via
	 * Steam's tag metadata, but if something still slips through we scan
	 * the visible tag list and auto-skip when the NSFW filter is enabled.
	 *
	 * Return values:
	 *   - true  → banned tag definitely present
	 *   - false → tag container present and inspected, no banned tags found
	 *   - null  → tag container/text not ready yet; try again later
	 *
	 * @returns {boolean|null}
	 */
	function pageContainsBannedTagText() {
		if (!document.body) return null;

		try {
			// Only examine the main tag container on the app page so we don't
			// get tripped up by generic Steam UI text.
			// Modern layout:   <div class="glance_tags popular_tags">…</div>
			// Older layout:    <div class="glance_tags_ctn popular_tags_ctn">…</div>
			const tagContainer = document.querySelector(
				".glance_tags.popular_tags, .glance_tags_ctn.popular_tags_ctn"
			);

			if (!tagContainer) {
				// Tag container not present yet; try again on the next tick.
				return null;
			}

			// Steam usually renders each visible tag as an <a class="app_tag">.
			const tagNodes = tagContainer.querySelectorAll(".app_tag");

			// If tags haven't populated yet, wait for another mutation tick.
			if (!tagNodes || !tagNodes.length) {
				return null;
			}

			const tagTexts = [];

			tagNodes.forEach((node) => {
				const t = (node.textContent || "").trim();
				if (t) {
					tagTexts.push(t.toLowerCase());
				}
			});

			if (!tagTexts.length) {
				return null;
			}

			for (const banned of BANNED_TAGS) {
				if (!banned) continue;
				for (const tag of tagTexts) {
					if (tag.includes(banned)) {
						debug("pageContainsBannedTagText:tagHit", {
							banned,
							tagTexts,
						});
						return true;
					}
				}
			}

			debug("pageContainsBannedTagText:noMatch", {
				tagTexts,
			});

			return false;
		} catch (e) {
			// If anything goes wrong reading tags, wait and try again.
			return null;
		}
	}

	/**
	 * Wrapper around the existing random strategies that skips games
	 * with banned tags, while keeping the overall logic very simple.
	 *
	 * @param {"pure"|"smart"} mode
	 * @returns {Promise<number|null>}
	 */
	async function getFilteredRandomAppId(mode) {
		const picker =
			mode === "smart" ? getSmartRandomAppId : getPureRandomAppId;

		// Try a few times to avoid NSFW titles; fall back if everything fails.
		// Keep this number small to avoid hammering the Steam API.
		for (let i = 0; i < 4; i++) {
			const candidate = await picker();
			if (!candidate) break;

			const tags = await fetchAppTags(candidate);
			if (!hasBannedTag(tags)) {
				return candidate;
			}
		}

		// As a last resort, return whatever the picker gives us (may still be NSFW).
		return picker();
	}

	/**
	 * Resolve a random app id based on mode ("pure" | "smart"),
	 * and navigate to that app on the Steam store.
	 *
	 * @param {"pure"|"smart"} mode
	 */
	async function navigateToRandomApp(mode) {
		// Check if game limit reached
		if (ns.isGameLimitReached && ns.isGameLimitReached()) {
			alert('Game limit reached! Reset the counter or start a new seed to continue.');
			return;
		}

		let appid = null;

		// Only apply NSFW filtering when enabled in the seed UI.
		const useFilter =
			ns.getNSFWFilterEnabled && ns.getNSFWFilterEnabled();

		debug("navigateToRandomApp:enter", {
			mode,
			useFilter,
		});

		if (useFilter) {
			appid = await getFilteredRandomAppId(mode);
		} else if (mode === "smart") {
			appid = await getSmartRandomAppId();
		} else {
			appid = await getPureRandomAppId();
		}

		debug("navigateToRandomApp:resolvedAppId", {
			mode,
			useFilter,
			appid,
		});

		if (!appid) {
			// Fallback: Dota 2, in case everything fails
			appid = 570;

			debug("navigateToRandomApp:fallbackAppId", {
				mode,
				useFilter,
				appid,
			});
		}

		// Remember that this navigation was triggered by the extension so we
		// can potentially auto-skip NSFW pages on the destination without
		// messing up the play counter. We also track a small "chain" counter
		// so we can stop auto-skipping after several NSFW pages in a row.
		try {
			if (typeof sessionStorage !== "undefined") {
				let chain = 0;
				const prevRaw = sessionStorage.getItem(
					"reviewguesser:lastNavFromExtension"
				);
				if (prevRaw) {
					try {
						const prevInfo = JSON.parse(prevRaw);
						if (
							prevInfo &&
							typeof prevInfo.chain === "number" &&
							isFinite(prevInfo.chain)
						) {
							chain = prevInfo.chain;
						}
					} catch (e) {
						chain = 0;
					}
				}

				const navInfo = {
					appid: String(appid),
					mode,
					ts: Date.now(),
					chain: chain + 1
				};

				sessionStorage.setItem(
					"reviewguesser:lastNavFromExtension",
					JSON.stringify(navInfo)
				);

				debug("navigateToRandomApp:navInfoStored", navInfo);
			}
		} catch (e) {
			// Ignore storage issues
		}

		// Increment counter before navigating
		if (ns.incrementGameCounter) {
			ns.incrementGameCounter();
		}

		window.location.assign(
			`https://store.steampowered.com/app/${appid}/`
		);
	}

	/**
	 * When the NSFW filter is enabled, check the current page tags for
	 * banned NSFW terms. If found, undo the last game increment (if any)
	 * and automatically navigate to the next game using the current mode.
	 */
	function maybeAutoSkipNSFWPage() {
		debug("maybeAutoSkipNSFWPage:enter", {});

		// Only do anything when the experimental NSFW filter is enabled.
		if (!ns.getNSFWFilterEnabled || !ns.getNSFWFilterEnabled()) {
			debug("maybeAutoSkipNSFWPage:exit", {
				reason: "nsfwFilterDisabled",
			});
			return;
		}

		// Only act on Steam store pages.
		if (!ns.isSteamAppPage || !ns.isSteamAppPage()) {
			debug("maybeAutoSkipNSFWPage:exit", {
				reason: "notSteamAppPage",
				host: location.host,
			});
			return;
		}

		// Only handle navigations triggered by our own "Next" buttons so we
		// don't unexpectedly redirect pages the user opened manually.
		let navInfo = null;

		try {
			if (typeof sessionStorage !== "undefined") {
				const raw = sessionStorage.getItem(
					"reviewguesser:lastNavFromExtension"
				);
				if (raw) {
					navInfo = JSON.parse(raw);
				}
			}
		} catch (e) {
			navInfo = null;
		}

		if (!navInfo) {
			debug("maybeAutoSkipNSFWPage:exit", {
				reason: "noNavInfo",
			});
			return;
		}

		const currentAppId =
			ns.getCurrentSteamAppId && ns.getCurrentSteamAppId();

		if (!currentAppId || String(currentAppId) !== String(navInfo.appid)) {
			debug("maybeAutoSkipNSFWPage:exit", {
				reason: "appidMismatchOrMissing",
				currentAppId,
				navInfoAppId: navInfo.appid,
			});
			return;
		}

		// Prevent multiple auto-skips on the same app id in case this
		// logic gets re-run due to DOM mutations or SPA navigation hooks.
		if (String(currentAppId) === String(lastAutoSkippedAppId)) {
			debug("maybeAutoSkipNSFWPage:exit", {
				reason: "alreadyAutoSkippedThisApp",
				currentAppId,
			});
			return;
		}

		// Optional safety: ignore very old entries just in case.
		if (
			typeof navInfo.ts === "number" &&
			Date.now() - navInfo.ts > 60 * 1000
		) {
			try {
				sessionStorage.removeItem("reviewguesser:lastNavFromExtension");
			} catch (e) {
				// Ignore
			}

			debug("maybeAutoSkipNSFWPage:exit", {
				reason: "navInfoTooOld",
				ageMs: Date.now() - navInfo.ts,
			});
			return;
		}

		// Hard safety: if we've auto-skipped too many times in a row, stop to
		// avoid hammering Steam with requests.
		if (
			typeof navInfo.chain === "number" &&
			navInfo.chain >= 5
		) {
			try {
				sessionStorage.removeItem("reviewguesser:lastNavFromExtension");
			} catch (e) {
				// Ignore
			}

			debug("maybeAutoSkipNSFWPage:exit", {
				reason: "chainLimitReached",
				chain: navInfo.chain,
			});
			return;
		}

		debug("maybeAutoSkipNSFWPage:beforeTagScan", {
			appid: currentAppId,
			navInfoChain: navInfo.chain,
		});

		// Perform a quick tag scan for banned NSFW tags/keywords.
		const tagScan = pageContainsBannedTagText();

		if (tagScan === null) {
			// Tags not ready yet – leave nav info intact so we can check again
			// on the next MutationObserver / location change tick.
			debug("maybeAutoSkipNSFWPage:exit", {
				reason: "tagsNotReady",
			});
			return;
		}

		if (tagScan === false) {
			// Page looks safe – clear the marker so future clicks start a fresh chain.
			try {
				sessionStorage.removeItem("reviewguesser:lastNavFromExtension");
			} catch (e) {
				// Ignore
			}

			debug("maybeAutoSkipNSFWPage:exit", {
				reason: "noBannedTagsOnPage",
			});
			return;
		}

		// Remember that we've auto-skipped this app id so we don't trigger
		// multiple "next game" navigations for the same NSFW page.
		lastAutoSkippedAppId = String(currentAppId);

		debug("maybeAutoSkipNSFWPage:nsfwDetected", {
			appid: currentAppId,
			mode: navInfo.mode,
		});

		// NSFW content detected on this page: undo the last increment (if any)
		// and jump to the next random game using the current mode.
		// Clear nav marker first so repeated calls on this page don't keep
		// chaining additional navigations.
		try {
			sessionStorage.removeItem("reviewguesser:lastNavFromExtension");
		} catch (e) {
			// Ignore
		}

		if (ns.decrementGameCounter) {
			ns.decrementGameCounter();
		}

		let nextMode = null;

		if (ns.getGameMode) {
			const currentMode = ns.getGameMode();
			if (currentMode === "pure" || currentMode === "smart") {
				nextMode = currentMode;
			}
		}

		if (!nextMode) {
			nextMode = "smart";
		}

		debug("maybeAutoSkipNSFWPage:navigateNext", {
			nextMode,
		});

		// Schedule on the next tick so we don't confuse any code that is
		// still reacting to the current page.
		setTimeout(() => {
			navigateToRandomApp(nextMode);
		}, 0);
	}

	/**
	 * Create a "Next Game" button with the given label and strategy.
	 *
	 * @param {string} label - Button text ("Pure Random" / "Smart Random")
	 * @param {"pure"|"smart"} mode
	 * @returns {HTMLAnchorElement}
	 */
	function makeNextGameButton(label, mode) {
		const a = document.createElement("a");
		a.className = "btnv6_blue_hoverfade btn_medium ext-next-game";
		a.href = "#";
		a.dataset.mode = mode;

		const span = document.createElement("span");
		span.textContent = label;
		a.appendChild(span);

		// Update button state based on limit and game mode
		const updateButtonState = () => {
			// Check if this button's mode matches the selected game mode
			const currentGameMode = ns.getGameMode ? ns.getGameMode() : null;
			
			// Hide button if game mode is set and doesn't match this button's mode
			if (currentGameMode !== null && currentGameMode !== mode) {
				a.style.display = 'none';
				return;
			} else {
				a.style.display = '';
			}

			// Update disabled state based on game limit
			if (ns.isGameLimitReached && ns.isGameLimitReached()) {
				a.classList.add('ext-disabled');
				a.setAttribute('aria-disabled', 'true');
				span.textContent = label + ' (Limit Reached)';
			} else {
				a.classList.remove('ext-disabled');
				a.removeAttribute('aria-disabled');
				span.textContent = label;
			}
		};

		updateButtonState();

		// Listen for game count and seed changes (including mode changes)
		window.addEventListener('ext:gamecountchanged', updateButtonState);
		window.addEventListener('ext:seedchanged', updateButtonState);

		a.addEventListener(
			"click",
			(e) => {
				e.preventDefault();
				if (!a.classList.contains('ext-disabled')) {
					navigateToRandomApp(mode);
				}
			},
			{ passive: false }
		);

		return a;
	}

  // ---------------------------------------------------------------------------
  // Oops / region-locked page: header button(s)
  // ---------------------------------------------------------------------------

  function installNextGameButtonOnOops() {
    const header = document.querySelector(
      ".page_header_ctn .page_content"
    );
    if (!header) return;

    // Avoid duplicates – if we already placed any ext-next-game, stop.
    if (header.querySelector(".ext-next-game")) return;

    const target =
      header.querySelector("h2.pageheader") || header;

    // Wrap both buttons in a simple row
    const pureBtn = makeNextGameButton("Next (Raw)", "pure");
    const smartBtn = makeNextGameButton("Next (Balanced)", "smart");

    const row = document.createElement("div");
    row.style.marginTop = "10px";
    row.style.display = "flex";
    row.style.gap = "8px";
    row.appendChild(pureBtn);
    row.appendChild(smartBtn);

    if (target && target.parentElement) {
      target.insertAdjacentElement("afterend", row);
    } else {
      header.appendChild(row);
    }
  }

  // ---------------------------------------------------------------------------
  // Normal app page: replace Community Hub with two buttons
  // ---------------------------------------------------------------------------

  function installNextGameButton() {
    const container = document.querySelector(
      ".apphub_HomeHeaderContent .apphub_OtherSiteInfo"
    );
    if (!container) return;

    // Avoid duplicates
    if (container.querySelector(".ext-next-game")) return;

    // Remove the original Community Hub button, if present
    const hubBtn = container.querySelector(
      "a.btnv6_blue_hoverfade.btn_medium"
    );
    if (hubBtn) hubBtn.remove();

    const pureBtn = makeNextGameButton("Next (Raw)", "pure");
    const smartBtn = makeNextGameButton("Next (Balanced)", "smart");

    // Let Steam's layout handle positioning; just drop them in order
    container.appendChild(pureBtn);
    container.appendChild(smartBtn);
  }

  // Expose on namespace
  ns.getReleasedAppIds = getReleasedAppIds;
  ns.installNextGameButtonOnOops = installNextGameButtonOnOops;
  ns.installNextGameButton = installNextGameButton;
	ns.maybeAutoSkipNSFWPage = maybeAutoSkipNSFWPage;
})(window);
