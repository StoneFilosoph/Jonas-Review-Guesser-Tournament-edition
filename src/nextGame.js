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

		if (mode === "smart") {
			appid = await getSmartRandomAppId();
		} else {
			appid = await getPureRandomAppId();
		}

		if (!appid) {
			// Fallback: Dota 2, in case everything fails
			appid = 570;
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
})(window);
