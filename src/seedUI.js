(function (root) {
	const ns = (root.ReviewGuesser = root.ReviewGuesser || {});

	const setSeed = ns.setSeed;
	const getCurrentSeed = ns.getCurrentSeed;
	const resetSeed = ns.resetSeed;
	const getGameCounter = ns.getGameCounter;
	const getMaxGames = ns.getMaxGames;
	const resetGameCounter = ns.resetGameCounter;
	const setMaxGames = ns.setMaxGames;
	const getGameMode = ns.getGameMode;
	const setGameMode = ns.setGameMode;
	const getNSFWFilterEnabled = ns.getNSFWFilterEnabled;
	const setNSFWFilterEnabled = ns.setNSFWFilterEnabled;
	const getCorrectCounter = ns.getCorrectCounter;
	const resetCorrectCounter = ns.resetCorrectCounter;

	/**
	 * Save current UI state to preserve user input during page updates
	 */
	function saveDraftState() {
		const input = document.querySelector('.ext-seed-input');
		
		if (input) {
			try {
				const currentSeed = getCurrentSeed() || '';
				const inputValue = input.value.trim();
				
				// Only save draft if user has modified the input
				if (inputValue !== currentSeed && inputValue !== 'Loading...') {
					localStorage.setItem('reviewguesser:draft:seed', inputValue);
					localStorage.setItem('reviewguesser:draft:timestamp', String(Date.now()));
				} else {
					// Clear draft if input matches current seed
					clearDraftState();
				}
			} catch (e) {
				console.warn('[ext] Failed to save draft state', e);
			}
		}
	}

	/**
	 * Load draft seed if it's recent (within last 5 minutes)
	 * @returns {string|null}
	 */
	function loadDraftState() {
		try {
			const timestamp = localStorage.getItem('reviewguesser:draft:timestamp');
			if (timestamp) {
				const age = Date.now() - parseInt(timestamp, 10);
				// Only restore draft if less than 5 minutes old
				if (age < 5 * 60 * 1000) {
					return localStorage.getItem('reviewguesser:draft:seed');
				} else {
					// Clean up old draft
					clearDraftState();
				}
			}
		} catch (e) {
			console.warn('[ext] Failed to load draft state', e);
		}
		return null;
	}

	/**
	 * Clear draft state after successful application
	 */
	function clearDraftState() {
		try {
			localStorage.removeItem('reviewguesser:draft:seed');
			localStorage.removeItem('reviewguesser:draft:timestamp');
		} catch (e) {
			console.warn('[ext] Failed to clear draft state', e);
		}
	}

	// Periodic auto-save interval
	let autoSaveInterval = null;

	/**
	 * Start periodic auto-save of draft state
	 */
	function startAutoSave() {
		if (!autoSaveInterval) {
			// Save draft every 2 seconds while UI is active
			autoSaveInterval = setInterval(() => {
				if (document.querySelector('.ext-seed-ui')) {
					saveDraftState();
				} else {
					// Stop auto-save if UI is removed
					stopAutoSave();
				}
			}, 2000);
		}
	}

	/**
	 * Stop periodic auto-save
	 */
	function stopAutoSave() {
		if (autoSaveInterval) {
			clearInterval(autoSaveInterval);
			autoSaveInterval = null;
		}
	}

	/**
	 * Create and inject the seed management UI
	 */
	function injectSeedUI() {
		// Save draft state before potential removal
		saveDraftState();

		// Remove existing seed UI if present
		const existing = document.querySelector('.ext-seed-ui');
		if (existing) {
			return; // Already exists, don't recreate
		}

		// Find a stable container to attach to
		// Try multiple locations in order of preference
		const targetContainer = 
			document.querySelector('.game_page_background .leftcol') ||
			document.querySelector('.page_content_ctn') ||
			document.querySelector('.game_area_purchase_game') ||
			document.querySelector('.game_page_background') ||
			ns.getSteamReviewsContainer && ns.getSteamReviewsContainer() ||
			document.querySelector('body');

		if (!targetContainer) {
			console.log('[ext] Seed UI: No suitable container found yet');
			return;
		}

		console.log('[ext] Seed UI: Injecting into', targetContainer.className || targetContainer.tagName);

		// Create seed UI container
		const seedUI = document.createElement('div');
		seedUI.className = 'ext-seed-ui';

		// Ensure RNG is initialized (loads state from localStorage)
		if (ns.getRNG) {
			ns.getRNG();
		}

		// Load draft seed or use current state
		const draftSeed = loadDraftState();
		const currentSeed = getCurrentSeed() || 'Loading...';
		const gameCount = getGameCounter ? getGameCounter() : 0;
		const maxGames = getMaxGames ? getMaxGames() : null;
		const correctCount = getCorrectCounter ? getCorrectCounter() : 0;
		const gameMode = getGameMode ? getGameMode() : null;
		const nsfwFilter = getNSFWFilterEnabled ? getNSFWFilterEnabled() : false;
		
		// Use draft seed if available, otherwise current seed
		const displaySeed = draftSeed || currentSeed;
		const limitDisplay = maxGames === null ? 'Unlimited' : maxGames;
		const modeDisplay = gameMode === 'pure' ? 'Raw' : gameMode === 'smart' ? 'Balanced' : 'Both';

		seedUI.innerHTML = `
			<div class="ext-score-banner">
				<span class="ext-score-label">Score:</span>
				<span class="ext-score-current">${correctCount}</span><span class="ext-score-separator">/</span><span class="ext-score-limit">${limitDisplay}</span>
			</div>
			<div class="ext-seed-controls">
				<div class="ext-seed-label">
					<span>🎲 Seed:</span>
				</div>
				<input 
					type="text" 
					class="ext-seed-input" 
					value="${displaySeed}"
					placeholder="Enter seed (e.g., ABC123:10)"
					maxlength="30"
				/>
				<select class="ext-seed-limit" title="Game limit">
					<option value="">Unlimited</option>
					<option value="5" ${maxGames === 5 ? 'selected' : ''}>5 games</option>
					<option value="10" ${maxGames === 10 ? 'selected' : ''}>10 games</option>
					<option value="20" ${maxGames === 20 ? 'selected' : ''}>20 games</option>
					<option value="50" ${maxGames === 50 ? 'selected' : ''}>50 games</option>
				</select>
				<select class="ext-seed-mode" title="Game mode">
					<option value="">Both modes</option>
					<option value="pure" ${gameMode === 'pure' ? 'selected' : ''}>Raw only</option>
					<option value="smart" ${gameMode === 'smart' ? 'selected' : ''}>Balanced only</option>
				</select>
				<label class="ext-seed-nsfw-toggle" title="Experimental NSFW tag filter">
					<input 
						type="checkbox" 
						class="ext-seed-nsfw-checkbox"
						${nsfwFilter ? 'checked' : ''}
					/>
					<span>Filter NSFW tags (experimental)</span>
				</label>
				<button type="button" class="ext-seed-btn ext-seed-apply" title="Apply seed">
					Apply
				</button>
				<button type="button" class="ext-seed-btn ext-seed-random" title="Generate new random seed">
					🔄 New
				</button>
				<button type="button" class="ext-seed-btn ext-seed-copy" title="Copy seed to clipboard">
					📋 Copy
				</button>
				<button type="button" class="ext-seed-btn ext-seed-share" title="Copy shareable link">
					🔗 Share
				</button>
				<button type="button" class="ext-seed-btn ext-seed-reset" title="Reset game counter">
					↺ Reset
				</button>
			</div>
			<div class="ext-seed-info">
				<span class="ext-game-counter">Game <span class="ext-game-count">${gameCount}</span> / <span class="ext-game-limit">${limitDisplay}</span></span>
				<span class="ext-seed-separator">•</span>
				<span class="ext-game-mode">Mode: <span class="ext-mode-display">${modeDisplay}</span></span>
				<span class="ext-seed-separator">•</span>
				<span>Share the seed with friends to compete!</span>
			</div>
		`;

		// Insert at the top of the target container
		targetContainer.insertBefore(seedUI, targetContainer.firstChild);

		// Add event listeners
		const input = seedUI.querySelector('.ext-seed-input');
		const limitSelect = seedUI.querySelector('.ext-seed-limit');
		const modeSelect = seedUI.querySelector('.ext-seed-mode');
		const applyBtn = seedUI.querySelector('.ext-seed-apply');
		const randomBtn = seedUI.querySelector('.ext-seed-random');
		const copyBtn = seedUI.querySelector('.ext-seed-copy');
		const shareBtn = seedUI.querySelector('.ext-seed-share');
		const resetBtn = seedUI.querySelector('.ext-seed-reset');
		const nsfwCheckbox = seedUI.querySelector('.ext-seed-nsfw-checkbox');

		// Save draft state when user types in seed input
		input.addEventListener('input', saveDraftState);

		// Apply button
		applyBtn.addEventListener('click', () => {
			const newSeed = input.value.trim();
			if (newSeed) {
				const limitValue = limitSelect.value;
				const limit = limitValue === '' ? null : parseInt(limitValue, 10);
				const modeValue = modeSelect.value;
				const mode = modeValue === '' ? null : modeValue;
				setSeed(newSeed, limit, mode);
				clearDraftState(); // Clear draft after successful application
				showFeedback(seedUI, 'Seed applied! Refreshing page...');
				setTimeout(() => {
					window.location.reload();
				}, 800);
			}
		});

		// Limit selector change
		limitSelect.addEventListener('change', () => {
			const limitValue = limitSelect.value;
			const limit = limitValue === '' ? null : parseInt(limitValue, 10);
			setMaxGames(limit);
			updateGameCounter();
			showFeedback(seedUI, 'Game limit updated!');
		});

		// Mode selector change
		modeSelect.addEventListener('change', () => {
			const modeValue = modeSelect.value;
			const mode = modeValue === '' ? null : modeValue;
			setGameMode(mode);
			updateGameMode();
			showFeedback(seedUI, 'Game mode updated!');
		});

		// NSFW filter toggle (experimental)
		if (nsfwCheckbox) {
			nsfwCheckbox.addEventListener('change', () => {
				const enabled = nsfwCheckbox.checked;
				if (setNSFWFilterEnabled) {
					setNSFWFilterEnabled(enabled);
				}
				showFeedback(
					seedUI,
					enabled
						? 'NSFW filter enabled (experimental)'
						: 'NSFW filter disabled'
				);
			});
		}

		// Enter key in input
		input.addEventListener('keypress', (e) => {
			if (e.key === 'Enter') {
				applyBtn.click();
			}
		});

		// Random seed button
		randomBtn.addEventListener('click', () => {
			const limitValue = limitSelect.value;
			const limit = limitValue === '' ? null : parseInt(limitValue, 10);
			const modeValue = modeSelect.value;
			const mode = modeValue === '' ? null : modeValue;
			const newSeed = resetSeed(limit, mode);
			input.value = newSeed;
			clearDraftState(); // Clear draft after generating new seed
			showFeedback(seedUI, 'New seed generated! Refreshing page...');
			setTimeout(() => {
				window.location.reload();
			}, 800);
		});

		// Copy seed button
		copyBtn.addEventListener('click', () => {
			const seed = getCurrentSeed();
			const max = getMaxGames();
			const fullSeed = max === null ? seed : `${seed}:${max}`;
			if (seed) {
				copyToClipboard(fullSeed);
				showFeedback(seedUI, 'Seed copied to clipboard!');
			}
		});

		// Share button (copy link with seed)
		shareBtn.addEventListener('click', () => {
			const seed = getCurrentSeed();
			const max = getMaxGames();
			const fullSeed = max === null ? seed : `${seed}:${max}`;
			if (seed) {
				const url = new URL(window.location.href);
				url.searchParams.set('seed', fullSeed);
				copyToClipboard(url.toString());
				showFeedback(seedUI, 'Shareable link copied!');
			}
		});

		// Reset counter button
		resetBtn.addEventListener('click', () => {
			if (resetGameCounter) {
				resetGameCounter();
			}
			if (resetCorrectCounter) {
				resetCorrectCounter();
			}
			updateGameCounter();
			showFeedback(seedUI, 'Game counter and score reset to 0!');
		});

		// Listen for game count and score changes
		window.addEventListener('ext:gamecountchanged', updateGameCounter);
		window.addEventListener('ext:scorechanged', updateGameCounter);
		window.addEventListener('ext:seedchanged', () => {
			updateGameCounter();
			updateSeedDisplay();
		});

		// Start periodic auto-save to preserve user input during page updates
		startAutoSave();
	}

	/**
	 * Copy text to clipboard
	 * @param {string} text
	 */
	function copyToClipboard(text) {
		if (navigator.clipboard && navigator.clipboard.writeText) {
			navigator.clipboard.writeText(text).catch((err) => {
				console.warn('[ext] Clipboard write failed', err);
				fallbackCopy(text);
			});
		} else {
			fallbackCopy(text);
		}
	}

	/**
	 * Fallback copy method using textarea
	 * @param {string} text
	 */
	function fallbackCopy(text) {
		const textarea = document.createElement('textarea');
		textarea.value = text;
		textarea.style.position = 'fixed';
		textarea.style.opacity = '0';
		document.body.appendChild(textarea);
		textarea.select();
		try {
			document.execCommand('copy');
		} catch (err) {
			console.warn('[ext] Fallback copy failed', err);
		}
		document.body.removeChild(textarea);
	}

	/**
	 * Show temporary feedback message
	 * @param {HTMLElement} container
	 * @param {string} message
	 */
	function showFeedback(container, message) {
		// Remove existing feedback
		const existing = container.querySelector('.ext-seed-feedback');
		if (existing) {
			existing.remove();
		}

		// Create feedback element
		const feedback = document.createElement('div');
		feedback.className = 'ext-seed-feedback';
		feedback.textContent = message;
		container.appendChild(feedback);

		// Remove after 2 seconds
		setTimeout(() => {
			if (feedback.parentNode) {
				feedback.remove();
			}
		}, 2000);
	}

	/**
	 * Update game counter display
	 */
	function updateGameCounter() {
		// Ensure RNG is initialized (loads state from localStorage)
		if (ns.getRNG) {
			ns.getRNG();
		}

		const countEl = document.querySelector('.ext-game-count');
		const limitEl = document.querySelector('.ext-game-limit');
		const scoreCurrentEl = document.querySelector('.ext-score-current');
		const scoreLimitEl = document.querySelector('.ext-score-limit');
		
		if (countEl && getGameCounter) {
			countEl.textContent = getGameCounter();
		}
		
		if (limitEl && getMaxGames) {
			const max = getMaxGames();
			limitEl.textContent = max === null ? 'Unlimited' : max;
		}

		if (scoreCurrentEl && getCorrectCounter) {
			scoreCurrentEl.textContent = getCorrectCounter();
		}

		if (scoreLimitEl && getMaxGames) {
			const max = getMaxGames();
			scoreLimitEl.textContent = max === null ? 'Unlimited' : max;
		}

		// Update limit selector
		const limitSelect = document.querySelector('.ext-seed-limit');
		if (limitSelect && getMaxGames) {
			const max = getMaxGames();
			limitSelect.value = max === null ? '' : String(max);
		}
	}

	/**
	 * Update game mode display
	 */
	function updateGameMode() {
		// Ensure RNG is initialized (loads state from localStorage)
		if (ns.getRNG) {
			ns.getRNG();
		}

		const modeDisplayEl = document.querySelector('.ext-mode-display');
		
		if (modeDisplayEl && getGameMode) {
			const mode = getGameMode();
			modeDisplayEl.textContent = mode === 'pure' ? 'Raw' : mode === 'smart' ? 'Balanced' : 'Both';
		}

		// Update mode selector
		const modeSelect = document.querySelector('.ext-seed-mode');
		if (modeSelect && getGameMode) {
			const mode = getGameMode();
			modeSelect.value = mode === null ? '' : String(mode);
		}
	}

	/**
	 * Update seed display
	 */
	function updateSeedDisplay() {
		// Ensure RNG is initialized (loads state from localStorage)
		if (ns.getRNG) {
			ns.getRNG();
		}

		const input = document.querySelector('.ext-seed-input');
		if (input && getCurrentSeed) {
			const currentSeed = getCurrentSeed();
			if (currentSeed && input.value !== currentSeed) {
				input.value = currentSeed;
			}
		}
		updateGameCounter();
		updateGameMode();
	}

	/**
	 * Update seed UI with current seed (for dynamic updates)
	 */
	function updateSeedUI() {
		updateSeedDisplay();
		updateGameCounter();
		updateGameMode();
	}

	/**
	 * Initialize seed from URL parameter if present
	 */
	function initializeSeedFromURL() {
		const urlParams = new URLSearchParams(window.location.search);
		const urlSeed = urlParams.get('seed');
		
		if (urlSeed) {
			setSeed(urlSeed);
			console.log('[ext] Seed loaded from URL:', urlSeed);
		}
	}

	// Expose on namespace
	ns.injectSeedUI = injectSeedUI;
	ns.updateSeedUI = updateSeedUI;
	ns.updateGameCounter = updateGameCounter;
	ns.initializeSeedFromURL = initializeSeedFromURL;
})(window);

