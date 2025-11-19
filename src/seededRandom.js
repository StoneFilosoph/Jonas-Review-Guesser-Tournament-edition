(function (root) {
	const ns = (root.ReviewGuesser = root.ReviewGuesser || {});

	/**
	 * Seeded Random Number Generator using Mulberry32 algorithm
	 * This allows deterministic "random" sequences based on a seed
	 */
	class SeededRNG {
		constructor(seed) {
			this.seed = seed >>> 0; // Convert to 32-bit unsigned integer
			this.state = this.seed;
		}

		/**
		 * Generate next random number between 0 and 1 (like Math.random())
		 * @returns {number} Random number [0, 1)
		 */
		next() {
			let t = (this.state += 0x6d2b79f5);
			t = Math.imul(t ^ (t >>> 15), t | 1);
			t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
			return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
		}

		/**
		 * Generate random integer between min and max (inclusive)
		 * @param {number} min
		 * @param {number} max
		 * @returns {number}
		 */
		randInt(min, max) {
			return Math.floor(this.next() * (max - min + 1)) + min;
		}

		/**
		 * Shuffle array in place using Fisher-Yates algorithm
		 * @param {Array} array
		 * @returns {Array} The same array, shuffled
		 */
		shuffle(array) {
			for (let i = array.length - 1; i > 0; i--) {
				const j = Math.floor(this.next() * (i + 1));
				[array[i], array[j]] = [array[j], array[i]];
			}
			return array;
		}

		/**
		 * Pick random element from array
		 * @param {Array} array
		 * @returns {*} Random element or null if empty
		 */
		pick(array) {
			if (!array || !array.length) return null;
			const idx = Math.floor(this.next() * array.length);
			return array[idx];
		}
	}

	// Seed management
	let currentSeed = null;
	let currentRNG = null;
	let gameCounter = 0;
	let correctCounter = 0; // number of correctly answered games
	let maxGames = null; // null = unlimited
	let gameMode = null; // null = both modes, "pure" = raw only, "smart" = balanced only
	let nsfwFilterEnabled = false; // experimental NSFW tag filtering

	/**
	 * Hash a string to a 32-bit number for use as seed
	 * @param {string} str
	 * @returns {number}
	 */
	function hashString(str) {
		let hash = 0;
		for (let i = 0; i < str.length; i++) {
			const char = str.charCodeAt(i);
			hash = (hash << 5) - hash + char;
			hash = hash & hash; // Convert to 32-bit integer
		}
		return hash >>> 0; // Ensure unsigned
	}

	/**
	 * Generate a random seed string (for when user doesn't provide one)
	 * @returns {string}
	 */
	function generateRandomSeedString() {
		const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
		let result = '';
		for (let i = 0; i < 8; i++) {
			result += chars.charAt(Math.floor(Math.random() * chars.length));
		}
		return result;
	}

	/**
	 * Parse seed string that may include game limit
	 * Format: "SEEDCODE" or "SEEDCODE:10" or "SEEDCODE:UNLIMITED"
	 * @param {string} seedString
	 * @returns {{seed: string, maxGames: number|null}}
	 */
	function parseSeedWithLimit(seedString) {
		const parts = seedString.split(':');
		const seed = parts[0].toUpperCase();
		let max = null;

		if (parts.length > 1) {
			const limitStr = parts[1].trim().toUpperCase();
			if (limitStr === 'UNLIMITED' || limitStr === '') {
				max = null;
			} else {
				const parsed = parseInt(limitStr, 10);
				if (Number.isFinite(parsed) && parsed > 0) {
					max = parsed;
				}
			}
		}

		return { seed, maxGames: max };
	}

	/**
	 * Initialize or update the global RNG with a seed
	 * @param {string|number} seed - Can be string or number, optionally with ":LIMIT"
	 * @param {number|null} limit - Optional game limit (overrides seed string limit)
	 * @param {string|null} mode - Optional game mode ("pure", "smart", or null for both)
	 * @returns {string} The seed string that was set (with limit if applicable)
	 */
	function setSeed(seed, limit, mode) {
		let seedString;
		let seedNumber;
		let gameLimit = limit;

		if (typeof seed === 'string') {
			// Parse seed with optional limit
			const parsed = parseSeedWithLimit(seed);
			seedString = parsed.seed;
			seedNumber = hashString(seedString);
			
			// Use limit from parameter if provided, otherwise from seed string
			if (limit === undefined || limit === null) {
				gameLimit = parsed.maxGames;
			}
		} else if (typeof seed === 'number') {
			seedNumber = seed >>> 0;
			seedString = String(seedNumber);
		} else {
			// Generate random seed
			seedString = generateRandomSeedString();
			seedNumber = hashString(seedString);
		}

		currentSeed = seedString;
		currentRNG = new SeededRNG(seedNumber);
		maxGames = gameLimit;
		gameCounter = 0; // Reset counters when seed changes
		correctCounter = 0;
		
		// Set game mode if provided
		if (mode !== undefined) {
			gameMode = mode;
		}

		// Store in localStorage
		try {
			localStorage.setItem('reviewguesser:seed', seedString);
			localStorage.setItem('reviewguesser:maxgames', gameLimit === null ? '' : String(gameLimit));
			localStorage.setItem('reviewguesser:gamecount', '0');
			localStorage.setItem('reviewguesser:correctcount', '0');
			localStorage.setItem('reviewguesser:gamemode', gameMode === null ? '' : String(gameMode));
			// Track how many times we've actually navigated (used for RNG restore).
			// This never gets decremented when NSFW pages are auto-skipped so
			// RNG state stays in sync with real navigation history.
			localStorage.setItem('reviewguesser:navcount', '0');
		} catch (e) {
			console.warn('[ext] Failed to save seed to localStorage', e);
		}

		// Dispatch event so UI can update
		window.dispatchEvent(new CustomEvent('ext:seedchanged', {
			detail: { seed: seedString, maxGames: gameLimit, gameCount: 0, gameMode: gameMode }
		}));

		return gameLimit === null ? seedString : `${seedString}:${gameLimit}`;
	}

	/**
	 * Get the current seed string
	 * @returns {string|null}
	 */
	function getCurrentSeed() {
		return currentSeed;
	}

	/**
	 * Get the current RNG instance (creates one if needed)
	 * @returns {SeededRNG}
	 */
	function getRNG() {
		if (!currentRNG) {
			// Try to load from localStorage
			let savedSeed = null;
			let savedMaxGames = null;
			let savedGameCount = 0;
			let savedCorrectCount = 0;
			let savedGameMode = null;
			let savedNavCount = null;
			
			try {
				savedSeed = localStorage.getItem('reviewguesser:seed');
				const maxGamesStr = localStorage.getItem('reviewguesser:maxgames');
				const gameCountStr = localStorage.getItem('reviewguesser:gamecount');
				const gameModeStr = localStorage.getItem('reviewguesser:gamemode');
				const correctCountStr = localStorage.getItem('reviewguesser:correctcount');
				const nsfwFilterStr = localStorage.getItem('reviewguesser:nsfwfilter');
				const navCountStr = localStorage.getItem('reviewguesser:navcount');
				
				if (maxGamesStr && maxGamesStr !== '') {
					savedMaxGames = parseInt(maxGamesStr, 10);
				}
				if (gameCountStr) {
					savedGameCount = parseInt(gameCountStr, 10) || 0;
				}
				if (gameModeStr && gameModeStr !== '') {
					savedGameMode = gameModeStr;
				}
				if (correctCountStr) {
					savedCorrectCount = parseInt(correctCountStr, 10) || 0;
				}

				if (nsfwFilterStr === '1') {
					nsfwFilterEnabled = true;
				} else if (nsfwFilterStr === '0') {
					nsfwFilterEnabled = false;
				}

				if (navCountStr && navCountStr !== '') {
					const parsedNav = parseInt(navCountStr, 10);
					if (Number.isFinite(parsedNav) && parsedNav >= 0) {
						savedNavCount = parsedNav;
					}
				}
			} catch (e) {
				// Ignore
			}

			// Check URL params
			const urlParams = new URLSearchParams(window.location.search);
			const urlSeed = urlParams.get('seed');

			if (urlSeed) {
				setSeed(urlSeed);
			} else if (savedSeed) {
				// Restore saved state
				const seedNumber = hashString(savedSeed);
				currentSeed = savedSeed;
				currentRNG = new SeededRNG(seedNumber);
				maxGames = savedMaxGames;
				gameCounter = savedGameCount;
				correctCounter = savedCorrectCount;
				gameMode = savedGameMode;

				// CRITICAL FIX: Advance RNG state based on how many times we've
				// actually navigated (navcount), not the visible game counter.
				// This keeps RNG progression correct even if we "undo" a game
				// in the counter when auto-skipping NSFW pages.
				const restoreCount =
					savedNavCount !== null && savedNavCount !== undefined
						? savedNavCount
						: savedGameCount;

				for (let i = 0; i < restoreCount * 10; i++) {
					currentRNG.next();
				}
			} else {
				setSeed(generateRandomSeedString());
			}
		}
		return currentRNG;
	}

	/**
	 * Reset seed (generate new random one)
	 * @param {number|null} limit - Optional game limit
	 * @param {string|null} mode - Optional game mode
	 * @returns {string} New seed string
	 */
	function resetSeed(limit, mode) {
		return setSeed(generateRandomSeedString(), limit, mode);
	}

	/**
	 * Increment game counter (call when navigating to next game)
	 * @returns {number} New game count
	 */
	function incrementGameCounter() {
		gameCounter++;
		try {
			localStorage.setItem('reviewguesser:gamecount', String(gameCounter));

			// Increase navigation count used for RNG restoration.
			let navCount = 0;
			const navStr = localStorage.getItem('reviewguesser:navcount');
			if (navStr && navStr !== '') {
				const parsed = parseInt(navStr, 10);
				if (Number.isFinite(parsed) && parsed >= 0) {
					navCount = parsed;
				}
			}
			navCount++;
			localStorage.setItem('reviewguesser:navcount', String(navCount));
		} catch (e) {
			console.warn('[ext] Failed to save game count', e);
		}

		// Dispatch event so UI can update
		window.dispatchEvent(new CustomEvent('ext:gamecountchanged', {
			detail: { gameCount: gameCounter, maxGames: maxGames }
		}));

		return gameCounter;
	}

	/**
	 * Increment correct answer counter (call when answering correctly)
	 * @returns {number} New correct count
	 */
	function incrementCorrectCounter() {
		correctCounter++;

		try {
			localStorage.setItem('reviewguesser:correctcount', String(correctCounter));
		} catch (e) {
			console.warn('[ext] Failed to save correct count', e);
		}

		// Separate event so UI can react specifically to score changes
		window.dispatchEvent(new CustomEvent('ext:scorechanged', {
			detail: { correctCount: correctCounter, maxGames: maxGames }
		}));

		return correctCounter;
	}

	/**
	 * Decrement game counter by 1 (used when auto-skipping NSFW pages).
	 * Does nothing if the counter is already 0.
	 *
	 * @returns {number} New game count
	 */
	function decrementGameCounter() {
		if (gameCounter <= 0) {
			return gameCounter;
		}

		gameCounter--;

		try {
            localStorage.setItem('reviewguesser:gamecount', String(gameCounter));
		} catch (e) {
			console.warn('[ext] Failed to save game count', e);
		}

		window.dispatchEvent(new CustomEvent('ext:gamecountchanged', {
			detail: { gameCount: gameCounter, maxGames: maxGames }
		}));

		return gameCounter;
	}

	/**
	 * Get current game counter
	 * @returns {number}
	 */
	function getGameCounter() {
		return gameCounter;
	}

	/**
	 * Get current correct-answer counter
	 * @returns {number}
	 */
	function getCorrectCounter() {
		return correctCounter;
	}

	/**
	 * Get max games limit
	 * @returns {number|null} null means unlimited
	 */
	function getMaxGames() {
		return maxGames;
	}

	/**
	 * Check if game limit has been reached
	 * @returns {boolean}
	 */
	function isGameLimitReached() {
		if (maxGames === null) return false;
		return gameCounter >= maxGames;
	}

	/**
	 * Reset game counter to 0 (restart challenge)
	 * @returns {number} New count (0)
	 */
	function resetGameCounter() {
		gameCounter = 0;
		correctCounter = 0;
		try {
			localStorage.setItem('reviewguesser:gamecount', '0');
			localStorage.setItem('reviewguesser:correctcount', '0');
		} catch (e) {
			console.warn('[ext] Failed to reset game count', e);
		}

		window.dispatchEvent(new CustomEvent('ext:gamecountchanged', {
			detail: { gameCount: 0, maxGames: maxGames }
		}));

		window.dispatchEvent(new CustomEvent('ext:scorechanged', {
			detail: { correctCount: 0, maxGames: maxGames }
		}));

		return 0;
	}

	/**
	 * Set max games limit without changing seed
	 * @param {number|null} limit - Game limit or null for unlimited
	 */
	function setMaxGames(limit) {
		maxGames = limit;
		try {
			localStorage.setItem('reviewguesser:maxgames', limit === null ? '' : String(limit));
		} catch (e) {
			console.warn('[ext] Failed to save max games', e);
		}

		window.dispatchEvent(new CustomEvent('ext:seedchanged', {
			detail: { seed: currentSeed, maxGames: limit, gameCount: gameCounter, gameMode: gameMode }
		}));
	}

	/**
	 * Get current game mode
	 * @returns {string|null} "pure", "smart", or null for both
	 */
	function getGameMode() {
		return gameMode;
	}

	/**
	 * Set game mode without changing seed
	 * @param {string|null} mode - Game mode ("pure", "smart", or null for both)
	 */
	function setGameMode(mode) {
		gameMode = mode;
		try {
			localStorage.setItem('reviewguesser:gamemode', mode === null ? '' : String(mode));
		} catch (e) {
			console.warn('[ext] Failed to save game mode', e);
		}

		window.dispatchEvent(new CustomEvent('ext:seedchanged', {
			detail: { seed: currentSeed, maxGames: maxGames, gameCount: gameCounter, gameMode: mode }
		}));
	}

	/**
	 * Get whether NSFW tag filtering is enabled.
	 * @returns {boolean}
	 */
	function getNSFWFilterEnabled() {
		return nsfwFilterEnabled;
	}

	/**
	 * Enable or disable NSFW tag filtering (experimental).
	 * @param {boolean} enabled
	 */
	function setNSFWFilterEnabled(enabled) {
		nsfwFilterEnabled = !!enabled;

		try {
			localStorage.setItem('reviewguesser:nsfwfilter', nsfwFilterEnabled ? '1' : '0');
		} catch (e) {
			console.warn('[ext] Failed to save NSFW filter flag', e);
		}

		window.dispatchEvent(new CustomEvent('ext:nsfwfilterchanged', {
			detail: { enabled: nsfwFilterEnabled }
		}));
	}

	// Expose on namespace
	ns.SeededRNG = SeededRNG;
	ns.setSeed = setSeed;
	ns.getCurrentSeed = getCurrentSeed;
	ns.getRNG = getRNG;
	ns.resetSeed = resetSeed;
	ns.hashString = hashString;
	ns.incrementGameCounter = incrementGameCounter;
	ns.incrementCorrectCounter = incrementCorrectCounter;
	ns.decrementGameCounter = decrementGameCounter;
	ns.getGameCounter = getGameCounter;
	ns.getCorrectCounter = getCorrectCounter;
	ns.getMaxGames = getMaxGames;
	ns.isGameLimitReached = isGameLimitReached;
	ns.resetGameCounter = resetGameCounter;
	ns.setMaxGames = setMaxGames;
	ns.getGameMode = getGameMode;
	ns.setGameMode = setGameMode;
	ns.parseSeedWithLimit = parseSeedWithLimit;
	ns.getNSFWFilterEnabled = getNSFWFilterEnabled;
	ns.setNSFWFilterEnabled = setNSFWFilterEnabled;
})(window);

