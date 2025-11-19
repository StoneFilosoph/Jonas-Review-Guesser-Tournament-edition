(function (root) {
  const ns = (root.ReviewGuesser = root.ReviewGuesser || {});

	const isSteamAppPage = ns.isSteamAppPage;
	const getCurrentSteamAppId = ns.getCurrentSteamAppId;
	const getSteamReviewsContainer = ns.getSteamReviewsContainer;
	const hideAllSteamReviewCounts = ns.hideAllSteamReviewCounts;
	const waitForAnyReviewCount = ns.waitForAnyReviewCount;
	const formatNum = ns.formatNum;
	const getRNG = ns.getRNG;
	const incrementCorrectCounter = ns.incrementCorrectCounter;
	const getTimerDuration = ns.getTimerDuration;
	const getGameMode = ns.getGameMode;
	const getGameCounter = ns.getGameCounter;

	function buildGuessSet(trueCount) {
		const MIN_ANSWERS = 6;
		const CAP = 200_000_000_000;

		// Normalise the true answer and cap it
		const TC = Math.max(
			0,
			Math.min(CAP, Math.trunc(Number(trueCount) || 0))
		);

		const answers = new Set();
		answers.add(TC);

		// Use seeded RNG instead of Math.random()
		const rng = getRNG();
		const randInt = (min, max) => rng.randInt(min, max);

    // Random minimum step between answers when going upwards (40–60)
    const MIN_STEP_INCREASE = randInt(40, 60);

    // Random limit for how many *downward* options we may generate: 2–5
    const maxDownGuesses = randInt(4, 5);

    //
    // 1) DOWNWARDS PHASE (divide by 5 with noise) — ONLY if TC >= MIN_STEP_INCREASE.
    //    Also limited to maxDownGuesses.
    //
    if (TC >= MIN_STEP_INCREASE) {
      let current = TC;
      let downCount = 0;

      while (answers.size < MIN_ANSWERS && downCount < maxDownGuesses) {
        if (current === 0) break;

        let divided = Math.floor(current / 5);

        // No progress? bail out to avoid infinite loops
        if (divided === current) break;

        // Small random wobble: [-3, 3]
        const noise = randInt(-3, 3);
        let next = divided + noise;

        // Clamp so it's still lower than the previous value and >= 0
        if (next < 0) next = 0;
        if (next >= current) next = current - 1;

        const beforeSize = answers.size;
        answers.add(next);
        if (answers.size > beforeSize) {
          downCount++;
        }

        current = next;

        // Stop downwards once we've reached below 50 (original rule)
        if (current < 50) break;
      }
    }

    //
    // 2) UPWARDS PHASE: multiply by 5 with noise and enforce a random min distance (40–60).
    //    This fills remaining slots with higher values.
    //
    let current = TC;

    while (answers.size < MIN_ANSWERS) {
      // Base "multiply by 5"
      let base = current * 5;

      // Small random wobble: [-2, 3]  (add up to 3, remove up to 2)
      const noise = randInt(-2, 3);
      let candidate = base + noise;

      if (candidate < 0) candidate = 0;

      // Enforce a minimum increase of MIN_STEP_INCREASE over the previous value
      if (candidate < current + MIN_STEP_INCREASE) {
        candidate = current + MIN_STEP_INCREASE;
      }

      // Cap very large values
      if (candidate > CAP) candidate = CAP;

      // Avoid duplicates by nudging up a bit if needed
      let tries = 0;
      while (answers.has(candidate) && candidate < CAP && tries < 10) {
        candidate++;
        tries++;
      }

      if (answers.has(candidate)) {
        // No more unique space reasonably nearby; stop the upward phase.
        break;
      }

      answers.add(candidate);
      current = candidate;
    }

    //
    // 3) Fallback: if we *still* have fewer than 6 answers,
    //    just fill upwards by +1 from the current max.
    //
    if (answers.size < MIN_ANSWERS) {
      let maxVal = Math.max(...answers);
      while (answers.size < MIN_ANSWERS && maxVal < CAP) {
        maxVal++;
        if (!answers.has(maxVal)) {
          answers.add(maxVal);
        }
      }
    }

    //
    // 4) LOWEST-OPTION TWEAK:
    //    If the lowest option is NOT the correct answer, then with 50% chance
    //    replace it with 0 or 1 (chosen randomly), while keeping all answers distinct.
    //
    if (answers.size > 0) {
      const values = Array.from(answers);
      let minVal = values[0];
      for (let i = 1; i < values.length; i++) {
        if (values[i] < minVal) minVal = values[i];
      }

		if (minVal !== TC && rng.next() < 0.5 && minVal < 20) {
			const candidates = rng.next() < 0.5 ? [0, 1] : [1, 0];

        for (const val of candidates) {
          // If replacing with the same value, no point; skip
          if (val === minVal) {
            // already that value, but it's still 0 or 1, so that's okay
            break;
          }
          // Avoid creating duplicates: allow if it's not already in the set
          if (!answers.has(val)) {
            answers.delete(minVal);
            answers.add(val);
            break;
          }
        }
      }
    }

	//
	// 5) Convert to array and shuffle so the correct answer isn't in a fixed spot.
	//
	const picks = Array.from(answers);

	// Use seeded shuffle
	rng.shuffle(picks);

	return picks;
}





  function ensureLoadingWidget(container, appId) {
    let wrap = container.querySelector(
      `.ext-steam-guess[data-ext-appid="${appId}"]`
    );
    if (!wrap) {
      wrap = document.createElement("div");
      wrap.className = "ext-steam-guess";
      wrap.dataset.extAppid = appId;
      const msg = document.createElement("div");
      msg.className = "ext-wait";
      msg.textContent = "Waiting for review count to load…";
      wrap.appendChild(msg);
      container.prepend(wrap);
    } else {
      const hasButtons = wrap.querySelector("button");
      if (!hasButtons) {
        let msg = wrap.querySelector(".ext-wait");
        if (!msg) {
          msg = document.createElement("div");
          msg.className = "ext-wait";
          wrap.appendChild(msg);
        }
        msg.textContent = "Waiting for review count to load…";
      }
    }
    container.classList.add("ext-mask-reviews");
    return wrap;
  }

  async function injectSteamGuessingGame() {
    if (!isSteamAppPage()) return;

    const appId = getCurrentSteamAppId() || "unknown";

    const existingWrap = document.querySelector(
      `.ext-steam-guess[data-ext-appid="${appId}"]`
    );
    if (existingWrap && existingWrap.dataset.state === "ready") {
      hideAllSteamReviewCounts();
      return;
    }

    document
      .querySelectorAll(".ext-steam-guess[data-ext-appid]")
      .forEach((el) => {
        if (el.getAttribute("data-ext-appid") !== appId) el.remove();
      });

    const container = getSteamReviewsContainer();
    if (!container) {
      return;
    }

    hideAllSteamReviewCounts();

    const wrap = ensureLoadingWidget(container, appId);
    if (!wrap) return;

    if (wrap.dataset.state === "ready") {
      hideAllSteamReviewCounts();
      return;
    }

    let trueCount = wrap.dataset.truecount
      ? parseInt(wrap.dataset.truecount, 10)
      : null;
    if (!Number.isFinite(trueCount)) {
      const got = await waitForAnyReviewCount(5000);
      if (!got) {
        if (!wrap.querySelector(".ext-error")) {
          wrap.innerHTML =
            '<div class="ext-error">Failed to load review count</div>';
        }
        return;
      }
      trueCount = got.count;
      wrap.dataset.truecount = String(trueCount);
    }

    if (wrap.dataset.state !== "ready") {
      const guesses = buildGuessSet(trueCount);
      wrap.dataset.guesses = JSON.stringify(guesses);
      wrap.innerHTML = "";

      const btns = [];
      guesses.forEach((val) => {
        const b = document.createElement("button");
        b.type = "button";
        b.dataset.value = String(val);
        b.textContent = formatNum(val);
        btns.push(b);
        wrap.appendChild(b);
      });

      // Timer logic
      const timerDuration = getTimerDuration ? getTimerDuration() : -1;
      // Only start timer if game counter > 0 (meaning we have started playing via "Next Game")
      const gameCounter = getGameCounter ? getGameCounter() : 0;
      let timerInterval = null;

      if (timerDuration > 0 && gameCounter > 0) {
        const timerEl = document.createElement("div");
        timerEl.className = "ext-timer";
        timerEl.style.fontSize = "24px";
        timerEl.style.marginBottom = "10px";
        timerEl.style.fontWeight = "bold";
        timerEl.style.textAlign = "center";
        timerEl.style.gridColumn = "1 / -1";
        timerEl.style.width = "100%";
        
        let timeLeft = timerDuration;
        timerEl.textContent = `⏱️ ${timeLeft}s`;
        wrap.prepend(timerEl);

        timerInterval = setInterval(() => {
          if (wrap.dataset.locked === "1") {
            clearInterval(timerInterval);
            return;
          }

          timeLeft--;
          timerEl.textContent = `⏱️ ${timeLeft}s`;
          
          if (timeLeft < 13) {
            timerEl.style.color = "#ff4c4c"; // Brighter red for visibility
          }

          if (timeLeft <= 0) {
            clearInterval(timerInterval);
            timerEl.textContent = "⏱️ Time's Up!";
            
            // Mark as locked so user can't guess anymore
            wrap.dataset.locked = "1";
            
            // Disable buttons
            btns.forEach((btn) => {
               btn.disabled = true;
               btn.setAttribute("aria-disabled", "true");
               btn.style.pointerEvents = "none";
            });

            // Automatically go to next game
            setTimeout(() => {
               // Access namespace dynamically to ensure it's available
               if (ns.navigateToRandomApp) {
                 const mode = (getGameMode && getGameMode()) || 'smart';
                 ns.navigateToRandomApp(mode);
               } else {
                 console.error("[ReviewGuesser] navigateToRandomApp not found!");
                 // Fallback reload if navigation is missing (shouldn't happen)
                 window.location.reload();
               }
            }, 1000);
          }
        }, 1000);
      }

      const note = document.createElement("div");
      note.className = "ext-subtle";
      note.textContent =
        "Guess the All Reviews count (all languages).";
      wrap.appendChild(note);

      const correct = trueCount;
      const mark = (picked) => {
        if (wrap.dataset.locked === "1") return;
        wrap.dataset.locked = "1";

        if (timerInterval) clearInterval(timerInterval);

        const isCorrect = picked === correct;
        if (isCorrect && typeof incrementCorrectCounter === "function") {
          incrementCorrectCounter();
        }

        btns.forEach((btn) => {
          const val = parseInt(btn.dataset.value, 10);
          if (val === correct) btn.classList.add("correct");
          if (val === picked && val !== correct)
            btn.classList.add("wrong");
          btn.disabled = true;
          btn.setAttribute("aria-disabled", "true");
          btn.style.pointerEvents = "none";
        });
      };
      btns.forEach((b) =>
        b.addEventListener(
          "click",
          () => mark(parseInt(b.dataset.value, 10)),
          { once: true }
        )
      );

      wrap.dataset.state = "ready";
    }
  }

  ns.injectSteamGuessingGame = injectSteamGuessingGame;
})(window);
