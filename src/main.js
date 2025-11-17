(function (root) {
  const ns = (root.ReviewGuesser = root.ReviewGuesser || {});

	function run() {
		// Initialize seed from URL if present (first time only)
		if (!window.__extSeedInitialized) {
			ns.initializeSeedFromURL && ns.initializeSeedFromURL();
			window.__extSeedInitialized = true;
		}

		// Ensure RNG / seed state (including NSFW filter flag) is loaded
		if (ns.getRNG) {
			ns.getRNG();
		}

		if (ns.hideAllSteamReviewCounts) {
			ns.hideAllSteamReviewCounts();
		}

		if (ns.isUnavailableRegionPage && ns.isUnavailableRegionPage()) {
			ns.installNextGameButtonOnOops &&
				ns.installNextGameButtonOnOops();
			return;
		}

		ns.installNextGameButton && ns.installNextGameButton();
		ns.injectSeedUI && ns.injectSeedUI();
		ns.injectSteamGuessingGame && ns.injectSteamGuessingGame();
		ns.maybeAutoSkipNSFWPage && ns.maybeAutoSkipNSFWPage();
	}

	// Initial run
	run();

  // React to DOM mutations (SPA / dynamic content)
  let scheduled = false;
  const obs = new MutationObserver(() => {
    if (scheduled) return;
    scheduled = true;
    requestAnimationFrame(() => {
      run();
      scheduled = false;
    });
  });

  obs.observe(document.documentElement, {
    childList: true,
    subtree: true,
  });

  // History hook for SPA navigation
  (function hookHistory() {
    if (window.__extHistoryHooked) return;
    window.__extHistoryHooked = true;

    const dispatch = () =>
      window.dispatchEvent(new Event("ext:locationchange"));

    const origPush = history.pushState;
    history.pushState = function () {
      origPush.apply(this, arguments);
      dispatch();
    };

    const origReplace = history.replaceState;
    history.replaceState = function () {
      origReplace.apply(this, arguments);
      dispatch();
    };

    window.addEventListener("popstate", dispatch);
    window.addEventListener("ext:locationchange", () =>
      setTimeout(() => run(), 50)
    );
  })();
})(window);
