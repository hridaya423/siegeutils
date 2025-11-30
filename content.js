const isFirefox = typeof browser !== 'undefined' && typeof browser.runtime !== 'undefined';
const browserAPI = isFirefox ? browser : {
  runtime: {
    sendMessage: (message, callback) => {
      chrome.runtime.sendMessage(message, callback);
    },
    getURL: (path) => chrome.runtime.getURL(path),
    get lastError() {
      return chrome.runtime.lastError;
    },
    onMessage: chrome.runtime.onMessage
  },
  storage: {
    sync: {
      get: (keys, callback) => chrome.storage.sync.get(keys, callback)
    }
  }
};

let isActive = false;
let techTreeData = null;
let userCoins = 0;
let userPurchases = [];
let currentCategory = 'laptop';
let selectedDevice = null;
let userGoals = [];
let isRouteCollapsed = true;
let currentRouteItem = null;
let comparisonMode = false;
let comparisonRouteItem = null;
let marketDialogueObserver = null;
let spookyJumpScareTimeout = null;
let hasShownSpookyJumpScare = false;
let spookyJumpScareCount = 0;
const MAX_SPOOKY_JUMPSCARES = 3;
let spookyAudioUnlocked = false;
let spookyBackgroundAudio = null;
let spookyScreamAudio = null;

const utils = {
  getCSRFToken() {
    const tokenElement = document.querySelector('meta[name="csrf-token"]');
    return tokenElement ? tokenElement.getAttribute('content') : null;
  },

  async apiRequest(endpoint, options = {}) {
    const token = this.getCSRFToken();
    if (!token) throw new Error('CSRF token not found');

    const response = await fetch(`https://siege.hackclub.com${endpoint}`, {
      headers: {
        'X-CSRF-Token': token,
        'Content-Type': 'application/json',
        ...options.headers
      },
      ...options
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }
    return response.json();
  },

  formatCoins(amount) {
    return `${amount} 🪙`;
  },

  canAfford(price) {
    return userCoins >= price;
  },

  isPurchased(itemName) {
    return userPurchases.some(p => p.item_name === itemName && p.quantity > 0);
  },

  getCurrentCoins() {
    const coffersTitle = this.findCoffersTitle();
    if (coffersTitle) {
      const coinMatch = coffersTitle.textContent.match(/Your coffers: (\d+)/);
      if (coinMatch) {
        return parseInt(coinMatch[1]);
      }
    }
    return userCoins || 0;
  },

  getDefaultDevice(category) {
    if (!techTreeData || !techTreeData[category]) {
      return null;
    }

    const initialNode = techTreeData[category].initialNode;
    if (!initialNode.options) {
      return initialNode.id;
    }
    return initialNode.options[0].id;
  },

  escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  },

  unescapeHtml(text) {
    const div = document.createElement('div');
    div.innerHTML = text;
    return div.textContent;
  },

  getCurrentWeek() {
    const week4StartDate = new Date('2025-09-22');
    const now = new Date();
    const timeDiff = now.getTime() - week4StartDate.getTime();
    const daysDiff = Math.floor(timeDiff / (1000 * 3600 * 24));
    const weeksDiff = Math.floor(daysDiff / 7);

    const currentWeek = 4 + weeksDiff;
    return currentWeek;
  },

  formatHours(totalHours) {
    const hours = Math.floor(totalHours);
    const minutes = Math.round((totalHours - hours) * 60);
    return `${hours}h ${minutes}m`;
  },

  findCoffersTitle() {
    return Array.from(document.querySelectorAll('.home-section-title'))
      .find(title => {
        const text = title.textContent || '';
        return text.trim().toLowerCase().startsWith('your coffers:');
      }) || null;
  },

  formatNumber(value, digits = 1) {
    if (!Number.isFinite(value)) return '0.0';
    return value.toFixed(digits);
  }
};

const bettingPredictor = {
  predictPersonalHours(weeklyHoursArray) {
    if (!weeklyHoursArray || weeklyHoursArray.length === 0) {
      return { prediction: 10, confidence: 0, decayRate: 0, consistency: 0 };
    }

    const alpha = 0.4;
    let ewma = weeklyHoursArray[0];

    for (let i = 1; i < weeklyHoursArray.length; i++) {
      ewma = alpha * weeklyHoursArray[i] + (1 - alpha) * ewma;
    }

    let decayRate = 0;
    if (weeklyHoursArray.length >= 4) {
      const recent = (weeklyHoursArray[weeklyHoursArray.length - 1] + weeklyHoursArray[weeklyHoursArray.length - 2]) / 2;
      const previous = (weeklyHoursArray[weeklyHoursArray.length - 3] + weeklyHoursArray[weeklyHoursArray.length - 4]) / 2;
      decayRate = previous > 0 ? (recent - previous) / previous : 0;
    }

    const mean = weeklyHoursArray.reduce((a, b) => a + b, 0) / weeklyHoursArray.length;
    const variance = weeklyHoursArray.reduce((sum, val) => sum + Math.pow(val - mean, 2), 0) / weeklyHoursArray.length;
    const stdDev = Math.sqrt(variance);
    const consistency = mean > 0 ? Math.max(0, 1 - (stdDev / mean)) : 0;

    const prediction = ewma * (1 + decayRate * 0.2);

    const dataConfidence = Math.min(weeklyHoursArray.length / 5, 1);
    const confidence = dataConfidence * consistency;

    return {
      prediction: Math.max(0, prediction),
      confidence,
      decayRate,
      consistency,
      mean,
      stdDev
    };
  },

  generatePersonalSuggestions(prediction) {
    const base = prediction.prediction;

    return {
      conservative: {
        label: 'Conservative',
        hours: Math.round(base * 0.75 * 2) / 2,
        multiplier: 1.5,
        winProbability: this.calculateWinProbability(base * 0.75, prediction)
      },
      moderate: {
        label: 'Moderate',
        hours: Math.round(base * 0.90 * 2) / 2,
        multiplier: 2.0,
        winProbability: this.calculateWinProbability(base * 0.90, prediction)
      },
      aggressive: {
        label: 'Aggressive',
        hours: Math.round(base * 1.10 * 2) / 2,
        multiplier: 2.5,
        winProbability: this.calculateWinProbability(base * 1.10, prediction)
      }
    };
  },

  calculateWinProbability(goalHours, prediction) {
    if (prediction.stdDev === 0) return goalHours <= prediction.prediction ? 0.9 : 0.1;

    const z = (goalHours - prediction.prediction) / prediction.stdDev;

    const probability = this.normalCDF(-z);

    return Math.max(0.01, Math.min(0.99, probability));
  },

  normalCDF(x) {
    const t = 1 / (1 + 0.2316419 * Math.abs(x));
    const d = 0.3989423 * Math.exp(-x * x / 2);
    const p = d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274))));
    return x > 0 ? 1 - p : p;
  },

  predictPersonalEfficiency(weeklyEfficiencyArray) {
    if (!weeklyEfficiencyArray || weeklyEfficiencyArray.length === 0) {
      return { prediction: 0, confidence: 0, decayRate: 0, consistency: 0 };
    }

    const alpha = 0.4;
    let ewma = weeklyEfficiencyArray[0];

    for (let i = 1; i < weeklyEfficiencyArray.length; i++) {
      ewma = alpha * weeklyEfficiencyArray[i] + (1 - alpha) * ewma;
    }

    let decayRate = 0;
    if (weeklyEfficiencyArray.length >= 4) {
      const recent = (weeklyEfficiencyArray[weeklyEfficiencyArray.length - 1] + weeklyEfficiencyArray[weeklyEfficiencyArray.length - 2]) / 2;
      const previous = (weeklyEfficiencyArray[weeklyEfficiencyArray.length - 3] + weeklyEfficiencyArray[weeklyEfficiencyArray.length - 4]) / 2;
      decayRate = previous > 0 ? (recent - previous) / previous : 0;
    }

    const mean = weeklyEfficiencyArray.reduce((a, b) => a + b, 0) / weeklyEfficiencyArray.length;
    const variance = weeklyEfficiencyArray.reduce((sum, val) => sum + Math.pow(val - mean, 2), 0) / weeklyEfficiencyArray.length;
    const stdDev = Math.sqrt(variance);
    const consistency = mean > 0 ? Math.max(0, 1 - (stdDev / mean)) : 0;

    const prediction = ewma;

    const dataConfidence = Math.min(weeklyEfficiencyArray.length / 5, 1);
    const confidence = dataConfidence * consistency;

    return {
      prediction: Math.max(0, prediction),
      confidence,
      decayRate,
      consistency,
      mean,
      stdDev
    };
  },

  predictGlobalHours(weeklyStatsMap, currentWeek) {
    if (!weeklyStatsMap || weeklyStatsMap.size === 0) {
      return { prediction: 1000, confidence: 0, trend: 'unknown' };
    }

    const weeks = Array.from(weeklyStatsMap.entries())
      .sort((a, b) => a[0] - b[0])
      .map(([week, stats]) => stats.totalHours);

    if (weeks.length === 0) {
      return { prediction: 1000, confidence: 0, trend: 'unknown' };
    }

    const recentWeeks = weeks.slice(-3);
    const prediction = recentWeeks.reduce((a, b) => a + b, 0) / recentWeeks.length;

    let trend = 'stable';
    if (weeks.length >= 3) {
      const recent = weeks[weeks.length - 1];
      const previous = weeks[weeks.length - 2];
      if (recent > previous * 1.1) trend = 'increasing';
      else if (recent < previous * 0.9) trend = 'decreasing';
    }

    const mean = weeks.reduce((a, b) => a + b, 0) / weeks.length;
    const variance = weeks.reduce((sum, val) => sum + Math.pow(val - mean, 2), 0) / weeks.length;
    const stdDev = Math.sqrt(variance);
    const confidence = mean > 0 ? Math.max(0, 1 - (stdDev / mean)) : 0;

    return { prediction, confidence, trend };
  }
};

const shopUtils = {
  extractedItems: null,

  async extractShopItemsFromPage() {
    return new Promise((resolve) => {
      try {
        browserAPI.runtime.sendMessage(
          { action: 'extractShopItems' },
          (response) => {
            if (browserAPI.runtime.lastError) {
              console.error('[Siege Utils] Message passing error:', browserAPI.runtime.lastError);
              resolve(null);
              return;
            }

            if (response?.success && response.data) {
              resolve(response.data);
            } else {
              console.warn('[Siege Utils] Failed to extract shop items:', response?.error);
              resolve(null);
            }
          }
        );
      } catch (error) {
        console.error('[Siege Utils] Error sending message to background:', error);
        resolve(null);
      }
    });
  },

  async getShopItems() {
    if (this.extractedItems) {
      return this.extractedItems;
    }

    this.extractedItems = await this.extractShopItemsFromPage();
    return this.extractedItems;
  },

  clearCache() {
    this.extractedItems = null;
  }
};

const projectStats = {
  sideloadCache: new Map(),

  getStoredStats() {
    const stored = localStorage.getItem('siege-utils-project-stats');
    return stored ? JSON.parse(stored) : {};
  },

  saveStats(stats) {
    localStorage.setItem('siege-utils-project-stats', JSON.stringify(stats));
    goals.refreshMicroGoals();
  },

  parseTimeString(timeStr) {
    let hours = 0;
    let minutes = 0;

    const hourMatch = timeStr.match(/(\d+)h/);
    const minuteMatch = timeStr.match(/(\d+)m/);

    if (hourMatch) hours = parseInt(hourMatch[1]) || 0;
    if (minuteMatch) minutes = parseInt(minuteMatch[1]) || 0;

    const totalHours = hours + (minutes / 60);

    return totalHours;
  },

  parseCoins(coinStr) {
    if (!coinStr) {
      return 0;
    }

    const normalizeNumber = (value) => parseFloat(value.replace(/,/g, ''));

    const valueMatch = coinStr.match(/value[:\s]*([\d.,]+)/i);
    if (valueMatch) {
      const parsed = normalizeNumber(valueMatch[1]);
      if (Number.isFinite(parsed)) {
        return parsed;
      }
    }

    const coinEmojiMatch = coinStr.match(/([\d.,]+)\s*🪙/);
    if (coinEmojiMatch) {
      const parsed = normalizeNumber(coinEmojiMatch[1]);
      if (Number.isFinite(parsed)) {
        return parsed;
      }
    }

    const allNumbers = coinStr.match(/[\d.,]+/g);
    if (allNumbers && allNumbers.length > 0) {
      const parsed = normalizeNumber(allNumbers[allNumbers.length - 1]);
      if (Number.isFinite(parsed)) {
        return parsed;
      }
    }

    return 0;
  },

  parseAverageScore(text) {
    if (!text) {
      return null;
    }

    const match = text.match(/avg\.?\s*score[:\s]*([\d.,]+)/i);
    if (match) {
      const value = parseFloat(match[1].replace(/,/g, ''));
      return Number.isFinite(value) ? value : null;
    }

    return null;
  },

  calculateBaseCoinMultiplier(week, hours) {
    if (!Number.isFinite(hours) || hours <= 0) {
      return 0;
    }

    if (!Number.isFinite(week) || week <= 4) {
      return 2;
    }

    const cappedFirstHours = Math.min(hours, 10);
    const remainingHours = Math.max(0, hours - 10);
    const totalBaseCoins = cappedFirstHours * 0.5 + remainingHours * 2;
    return totalBaseCoins / hours;
  },

  parseWeek(weekStr) {
    const match = weekStr.match(/Week (\d+)/);
    return match ? parseInt(match[1]) : 1;
  },

  generateDiscreteVoterAverages() {
    const averages = [];
    for (let i = 10; i <= 50; i++) {
      averages.push(i / 10);
    }
    return averages;
  },

  estimateReviewerAndVoterStats(totalCoins, week, hours) {
    const typicalReviewerBonus = 2.5;
    const typicalAvgStars = 3.0;

    if (!totalCoins || !hours) {
      return { reviewerBonus: typicalReviewerBonus, avgVoterStars: typicalAvgStars };
    }

    const stats = this.getStoredStats();
    const baseRate = Math.max(0.1, this.calculateBaseCoinMultiplier(week, hours));
    const target = totalCoins / (baseRate * hours);

    const pastProjects = Object.values(stats).filter(p => p.week === week);
    let historicalRbAvg = typicalReviewerBonus;
    let historicalStarsAvg = typicalAvgStars;

    if (pastProjects.length > 0) {
      historicalRbAvg = pastProjects.reduce((sum, p) => sum + p.reviewer_bonus, 0) / pastProjects.length;
      historicalStarsAvg = pastProjects.reduce((sum, p) => sum + p.avg_score, 0) / pastProjects.length;
    }

    const rbBiasTarget = Math.min(3, Math.max(0.5, historicalRbAvg));
    const starsBiasTarget = Math.min(5, Math.max(1, historicalStarsAvg));
    const baseFlexCeiling = Math.min(2.7, Math.max(2.2, rbBiasTarget + 0.1));

    const validCombinations = [];
    const discreteVoterAverages = this.generateDiscreteVoterAverages();

    for (let rb = 1.0; rb <= 3.0; rb = Math.round((rb + 0.1) * 10) / 10) {
      for (const avgStars of discreteVoterAverages) {
        const calculatedTarget = rb * avgStars;
        const targetDeviation = Math.abs(calculatedTarget - target);

        if (target > 0 && targetDeviation / target < 0.25) {
          const starFlexBoost = Math.max(0, avgStars - starsBiasTarget);
          const effectiveCeiling = baseFlexCeiling + starFlexBoost * 0.3;
          const lowStarPenaltyFactor = 1 + Math.max(0, starsBiasTarget - avgStars) * 0.7;
          const lowStarOvershootPenalty = avgStars < starsBiasTarget + 0.2
            ? Math.max(0, rb - Math.min(2.45, effectiveCeiling - 0.12)) * 0.32 * (1 + (starsBiasTarget - avgStars) * 0.85)
            : 0;

          const rbCorrection = (rb - rbBiasTarget) * -0.14;
          const starsCorrection = (avgStars - starsBiasTarget) * 0.09;
          const rbPenalty = Math.abs(rb - rbBiasTarget) * 0.09;
          const starsPenalty = Math.abs(avgStars - starsBiasTarget) * 0.02;
          const rbOvershootPenalty = Math.max(0, rb - effectiveCeiling) * 0.18 * lowStarPenaltyFactor;
          const adjustedDeviation = targetDeviation + rbCorrection + starsCorrection + rbPenalty + starsPenalty + rbOvershootPenalty + lowStarOvershootPenalty;
          const quality = 1 / (adjustedDeviation + 0.015);

          validCombinations.push({
            reviewerBonus: rb,
            avgVoterStars: avgStars,
            correlationDeviation: adjustedDeviation,
            targetDeviation,
            quality
          });
        }
      }
    }

    if (validCombinations.length === 0) {
      return { reviewerBonus: rbBiasTarget, avgVoterStars: starsBiasTarget };
    }

    validCombinations.sort((a, b) => a.correlationDeviation - b.correlationDeviation);
    const topResults = validCombinations.slice(0, Math.min(3, validCombinations.length));

    let totalRb = 0;
    let totalStars = 0;
    let totalWeight = 0;

    topResults.forEach((result) => {
      totalRb += result.reviewerBonus * result.quality;
      totalStars += result.avgVoterStars * result.quality;
      totalWeight += result.quality;
    });

    const avgReviewerBonus = totalRb / totalWeight;
    const avgVoterStars = totalStars / totalWeight;

    const finalFlexCeiling = baseFlexCeiling + Math.max(0, avgVoterStars - starsBiasTarget) * 0.3;
    const dampenedReviewerBonus = avgReviewerBonus > finalFlexCeiling
      ? finalFlexCeiling + (avgReviewerBonus - finalFlexCeiling) * 0.38
      : avgReviewerBonus;
    const blendedReviewerBonus = (dampenedReviewerBonus * 0.51) + (rbBiasTarget * 0.49);
    const blendedAvgStars = (avgVoterStars * 0.75) + (starsBiasTarget * 0.25);

    let finalReviewerBonus = Math.min(3, Math.max(0.5, Math.round(blendedReviewerBonus * 10) / 10));
    let finalVoterStars = Math.min(5, Math.max(1, Math.round(blendedAvgStars * 10) / 10));

    if (totalCoins > 0 && baseRate > 0 && target > 0) {
      const requiredProduct = target;
      let currentProduct = finalReviewerBonus * finalVoterStars;

      if (requiredProduct > 0) {
        const diffRatio = Math.abs(currentProduct - requiredProduct) / requiredProduct;

        if (diffRatio > 0.05) {
          const rbToMatch = Math.min(3, Math.max(0.5, requiredProduct / finalVoterStars));
          const lowStarStrictCeiling = finalVoterStars <= starsBiasTarget
            ? Math.min(finalFlexCeiling, 2.35 + Math.max(0, finalVoterStars - 2.2) * 0.25)
            : finalFlexCeiling;

          if (finalVoterStars < starsBiasTarget + 0.15 && Math.abs(rbToMatch - finalReviewerBonus) > 0.2) {
            const starsToMatch = Math.min(5, Math.max(1, requiredProduct / finalReviewerBonus));
            finalVoterStars = Math.round(starsToMatch * 10) / 10;
          } else {
            finalReviewerBonus = Math.round(Math.min(lowStarStrictCeiling, rbToMatch) * 10) / 10;
          }

          currentProduct = finalReviewerBonus * finalVoterStars;
          const updatedDiff = requiredProduct > 0 ? Math.abs(currentProduct - requiredProduct) / requiredProduct : 0;

          if (updatedDiff > 0.05) {
            const starsToMatch = Math.min(5, Math.max(1, requiredProduct / finalReviewerBonus));
            finalVoterStars = Math.round(starsToMatch * 10) / 10;
            if (finalVoterStars < starsBiasTarget) {
              finalReviewerBonus = Math.min(finalReviewerBonus, lowStarStrictCeiling);
            }
          }
        }
      }
    }

    if (finalVoterStars < starsBiasTarget) {
      const voterGap = Math.max(0, starsBiasTarget - finalVoterStars);
      const lowStarAnchor = 2.32 + Math.max(0, finalVoterStars - 2.2) * 0.3;
      const anchorBlend = Math.min(0.85, 0.45 + voterGap * 0.18);
      finalReviewerBonus = (lowStarAnchor * anchorBlend) + (finalReviewerBonus * (1 - anchorBlend));

      if (finalVoterStars <= 2.6) {
        const starGap = 2.6 - finalVoterStars;
        const softCeiling = lowStarAnchor + 0.25 + Math.max(0, finalVoterStars - 2.2) * 0.2;
        if (finalReviewerBonus > softCeiling) {
          const overshoot = finalReviewerBonus - softCeiling;
          const bleedThrough = Math.max(0.15, 0.4 - starGap * 0.6);
          finalReviewerBonus = softCeiling + overshoot * bleedThrough;
        }
      }

      finalReviewerBonus = Math.min(finalReviewerBonus, 2.75);
    }

    finalReviewerBonus = Math.min(3, Math.max(0.5, Math.round(finalReviewerBonus * 10) / 10));
    finalVoterStars = Math.min(5, Math.max(1, Math.round(finalVoterStars * 10) / 10));

    return {
      reviewerBonus: finalReviewerBonus,
      avgVoterStars: finalVoterStars
    };
  },

  calculateEfficiency(totalCoins, hours) {
    if (!hours) return 0;
    return totalCoins / hours;
  },


  async resolveProjectHours(projectId, { fallbackHours = null, projectWeek = null, track = false } = {}) {
    if (!projectId) {
      return null;
    }

    let resolvedHours = null;
    let hasExistingTracking = false;
    const currentWeek = utils.getCurrentWeek();
    const isCurrentWeek = projectWeek === currentWeek;

    if (isCurrentWeek) {
      const shouldTrackDuringFetch = track && !hasExistingTracking;

      const fetchPromise = this.sideloadProjectTime(projectId, { track: shouldTrackDuringFetch });
      const sideloadedHours = await fetchPromise;

      if (Number.isFinite(sideloadedHours) && sideloadedHours > 0) {
        resolvedHours = sideloadedHours;
        if (track && !hasExistingTracking) {
          const weekToSave = Number.isFinite(projectWeek) ? projectWeek : currentWeek;
          this.trackProjectTime(projectId, sideloadedHours, weekToSave);
          hasExistingTracking = true;
        }
      }

      if (!resolvedHours && Number.isFinite(fallbackHours) && fallbackHours > 0) {
        resolvedHours = fallbackHours;
      }

      return Number.isFinite(resolvedHours) && resolvedHours > 0 ? resolvedHours : null;
    }

    resolvedHours = Number.isFinite(fallbackHours) && fallbackHours > 0 ? fallbackHours : null;

    if (!resolvedHours) {
      const storedStats = this.getStoredStats();
      const storedEntry = storedStats[`project_${projectId}`];
      if (storedEntry && Number.isFinite(storedEntry.hours) && storedEntry.hours > 0) {
        resolvedHours = storedEntry.hours;
        if (!projectWeek && Number.isFinite(storedEntry.week)) {
          projectWeek = storedEntry.week;
        }
      }
    }

    if (!resolvedHours) {
      const timeTracking = this.getStoredTimeTracking();
      const trackingEntry = timeTracking?.[projectId];
      if (trackingEntry && Array.isArray(trackingEntry.snapshots) && trackingEntry.snapshots.length > 0) {
        const latestSnapshot = trackingEntry.snapshots[trackingEntry.snapshots.length - 1];
        if (latestSnapshot && Number.isFinite(latestSnapshot.hours) && latestSnapshot.hours > 0) {
          resolvedHours = latestSnapshot.hours;
          if (!projectWeek && Number.isFinite(latestSnapshot.week)) {
            projectWeek = latestSnapshot.week;
          }
          hasExistingTracking = true;
        }
      }
    }

    if (!resolvedHours) {
      const shouldTrackDuringFetch = track && !hasExistingTracking;
      let cacheEntry = this.sideloadCache.get(projectId);
      if (cacheEntry instanceof Promise) {
        cacheEntry = { promise: cacheEntry, tracked: false };
        this.sideloadCache.set(projectId, cacheEntry);
      }

      if (!cacheEntry) {
        const fetchPromise = this.sideloadProjectTime(projectId, { track: shouldTrackDuringFetch });
        cacheEntry = { promise: fetchPromise, tracked: shouldTrackDuringFetch };
        this.sideloadCache.set(projectId, cacheEntry);
      }

      const sideloadedHours = await cacheEntry.promise;
      if (Number.isFinite(sideloadedHours) && sideloadedHours > 0) {
        resolvedHours = sideloadedHours;
        if (cacheEntry.tracked) {
          hasExistingTracking = true;
        } else if (track && !hasExistingTracking) {
          const weekToSave = Number.isFinite(projectWeek) ? projectWeek : utils.getCurrentWeek();
          this.trackProjectTime(projectId, sideloadedHours, weekToSave);
          hasExistingTracking = true;
          cacheEntry.tracked = true;
        }
      } else {
        this.sideloadCache.delete(projectId);
      }
    }

    if (track && Number.isFinite(resolvedHours) && resolvedHours > 0 && !hasExistingTracking) {
      const weekToSave = Number.isFinite(projectWeek) ? projectWeek : utils.getCurrentWeek();
      this.trackProjectTime(projectId, resolvedHours, weekToSave);
    }

    return Number.isFinite(resolvedHours) && resolvedHours > 0 ? resolvedHours : null;
  },


  async extractProjectData(projectCard) {
    if (!projectCard || !projectCard.id) {
      return null;
    }

    const projectId = projectCard.id.replace('project_', '');
    if (!projectId) {
      return null;
    }

    const titleElement = projectCard.querySelector('.project-title');
    const badgeElement = projectCard.querySelector('.project-badge');
    const timeElement = projectCard.querySelector('.project-time');
    const valueElement = projectCard.querySelector('.project-status-indicator');

    if (!titleElement || !valueElement) {
      return null;
    }

    const title = titleElement.textContent.trim();
    const week = badgeElement ? this.parseWeek(badgeElement.textContent) : 1;
    const valueStr = valueElement.textContent || '';
    const totalCoins = this.parseCoins(valueStr);
    const avgScoreFromStatus = this.parseAverageScore(valueStr);

    let fallbackHours = null;
    if (timeElement) {
      const timeStr = timeElement.textContent.replace('Time spent: ', '');
      const parsedHours = this.parseTimeString(timeStr);
      if (Number.isFinite(parsedHours) && parsedHours > 0) {
        fallbackHours = parsedHours;
      }
    }

    const isExplorePage = window.location.pathname === '/armory/explore';
    const shouldTrackTime = totalCoins <= 0 && !isExplorePage;

    const resolvedHours = await this.resolveProjectHours(projectId, {
      fallbackHours,
      projectWeek: week,
      track: shouldTrackTime
    });

    if (!Number.isFinite(resolvedHours) || resolvedHours <= 0) {
      return null;
    }

    const stats = this.getStoredStats();

    let estimates = { avgVoterStars: 3.0, reviewerBonus: 2.0 };
    let coinsPerHour = 0;

    if (totalCoins > 0) {
      estimates = this.estimateReviewerAndVoterStats(totalCoins, week, resolvedHours);
      coinsPerHour = this.calculateEfficiency(totalCoins, resolvedHours);
    }

    const baseMultiplier = this.calculateBaseCoinMultiplier(week, resolvedHours);
    const hasValidAvgScore = Number.isFinite(avgScoreFromStatus) && avgScoreFromStatus > 0;
    let avgScore = hasValidAvgScore ? avgScoreFromStatus : estimates.avgVoterStars;
    let reviewerBonus = estimates.reviewerBonus;

    if (totalCoins > 0 && hasValidAvgScore && baseMultiplier > 0) {
      const computedBonus = totalCoins / (resolvedHours * baseMultiplier * avgScoreFromStatus);
      if (Number.isFinite(computedBonus) && computedBonus > 0) {
        if (computedBonus > 3) {
          reviewerBonus = 3;
          const recalculatedAvg = totalCoins / (resolvedHours * baseMultiplier * reviewerBonus);
          if (Number.isFinite(recalculatedAvg) && recalculatedAvg > 0) {
            avgScore = Math.min(5, Math.max(avgScoreFromStatus, Math.round(recalculatedAvg * 100) / 100));
          } else {
            avgScore = avgScoreFromStatus;
          }
        } else {
          reviewerBonus = Math.max(0.5, Math.min(3, Math.round(computedBonus * 100) / 100));
          avgScore = avgScoreFromStatus;
        }
      }
    }

    if (totalCoins > 0 && !coinsPerHour) {
      coinsPerHour = this.calculateEfficiency(totalCoins, resolvedHours);
    }

    const projectData = {
      projectId,
      title,
      week,
      hours: resolvedHours,
      totalCoins,
      avgScore,
      reviewerBonus,
      coinsPerHour
    };

    if (totalCoins > 0) {
      stats[`project_${projectId}`] = {
        avg_score: avgScore,
        reviewer_bonus: reviewerBonus,
        week,
        hours: parseFloat(resolvedHours.toFixed(2)),
        total_coins: totalCoins,
        coins_per_hour: parseFloat(coinsPerHour.toFixed(2))
      };
      this.saveStats(stats);
    }

    return projectData;
  },

  createEfficiencyBadge(projectData) {
    const { coinsPerHour, reviewerBonus, avgScore, totalCoins, hours, week } = projectData;

    if (totalCoins === 0) {
      let avgEfficiency;
      if (week >= 5) {
        avgEfficiency = goals.getWeek5PlusEfficiency();
      } else {
        avgEfficiency = this.getAverageEfficiency();
      }
      const projectedCoins = Math.round(hours * avgEfficiency);

      const stats = this.getStoredStats();
      const pastProjects = Object.values(stats);

      let avgReviewerBonus = 1.5;
      let avgVoterStars = 3.0;

      if (pastProjects.length > 0) {
        avgReviewerBonus = pastProjects.reduce((sum, p) => sum + p.reviewer_bonus, 0) / pastProjects.length;
        avgVoterStars = pastProjects.reduce((sum, p) => sum + p.avg_score, 0) / pastProjects.length;
      }

      return `
        <div class="siege-efficiency-box" style="
          margin-top: 0.5rem;
          padding: 1rem;
          position: relative;
          border: 3px solid rgba(59, 130, 246, 0.75);
          background: transparent;
          transition: all 160ms ease;
        ">
          <div style="position: relative; z-index: 1; text-align: center;">
            <div style="font-size: 1.1rem; font-weight: 600; margin-bottom: 0.25rem; color: #60a5fa;">
              ~${projectedCoins} 🪙 projected
            </div>
            <div style="font-size: 1rem; margin-bottom: 0.25rem;">
              ${hours.toFixed(1)}h spent • ${avgEfficiency.toFixed(1)} 🪙/h avg
            </div>
            <div style="font-size: 1rem; font-weight: 500; margin-bottom: 0.2rem;">
              ~×${avgReviewerBonus.toFixed(2)} reviewer bonus
            </div>
            <div style="font-size: 1rem; font-weight: 500;">
              ~${avgVoterStars.toFixed(1)}/5 ⭐ avg voter stars
            </div>
            <div style="font-size: 0.8rem; font-weight: 500; opacity: 0.6; margin-top: 0.25rem;">
              Projections based on your past efficiency
            </div>
          </div>
        </div>
      `;
    }

    let maxEfficiency;
    if (week <= 4) {
      maxEfficiency = 30;
    } else if (hours <= 10) {
      maxEfficiency = 7.5;
    } else {
      const maxFirst10 = 7.5;
      const maxAfter10 = 30;
      maxEfficiency = (10 * maxFirst10 + (hours - 10) * maxAfter10) / hours;
    }
    const percentage = Math.min((coinsPerHour / maxEfficiency) * 100, 100);

    let label = 'Low efficiency';
    if (percentage >= 70) {
      label = 'High efficiency';
    } else if (percentage >= 40) {
      label = 'Medium efficiency';
    } else {
      label = 'Low efficiency';
    }

    return `
      <div class="siege-efficiency-box" style="
        margin-top: 0.5rem;
        padding: 1rem;
        position: relative;
        border: 3px solid rgba(64, 43, 32, 0.75);
        background: transparent;
        transition: all 160ms ease;
      ">

        <div style="position: relative; z-index: 1; text-align: center;">
          <div style="font-size: 0.9rem; font-weight: 600; margin-bottom: 0.25rem;">
             ${coinsPerHour.toFixed(1)} 🪙/hour
          </div>
          <div style="font-size: 0.75rem; opacity: 0.8; margin-bottom: 0.25rem;">
            ${label} • top ${(100 - percentage).toFixed(0)}%
          </div>
          <div style="font-size: 0.9rem; font-weight: 500; margin-bottom: 0.2rem;">
            ~×${reviewerBonus.toFixed(2)} reviewer bonus
          </div>
          <div style="font-size: 0.9rem; font-weight: 500;">
            ~${avgScore}/5 ⭐ avg voter stars
          </div>
          <div style="font-size: 0.6rem; font-weight: 500;">
            Please do not fully trust the reviewer bonus & avg voter star estimates, it can be inaccurate.
          </div>
        </div>
      </div>
    `;
  },

  createDetailedStats(projectData) {
    const { avgScore, reviewerBonus, week, hours, totalCoins, coinsPerHour } = projectData;

    if (totalCoins === 0) {
      let avgEfficiency;
      if (week >= 5) {
        avgEfficiency = goals.getWeek5PlusEfficiency();
      } else {
        avgEfficiency = this.getAverageEfficiency();
      }
      const projectedCoins = Math.round(hours * avgEfficiency);

      const stats = this.getStoredStats();
      const pastProjects = Object.values(stats);

      let avgReviewerBonus = 1.5;
      let avgVoterStars = 3.0;

      if (pastProjects.length > 0) {
        avgReviewerBonus = pastProjects.reduce((sum, p) => sum + p.reviewer_bonus, 0) / pastProjects.length;
        avgVoterStars = pastProjects.reduce((sum, p) => sum + p.avg_score, 0) / pastProjects.length;
      }

      return `
        <div class="reviewer-feedback-container">
          <h3 class="reviewer-feedback-title">Project Stats (Projected)</h3>
          <div class="reviewer-feedback-content siege-project-stats-content">
            <div class="siege-project-stats-row">
              <span class="siege-project-stats-metric" style="color: #60a5fa;">~${projectedCoins} 🪙 projected</span>
              <span class="siege-project-stats-secondary">(${avgEfficiency.toFixed(1)} 🪙/h avg)</span>
            </div>
            <div class="siege-project-stats-row">
              <span class="siege-project-stats-metric">~×${avgReviewerBonus.toFixed(2)} reviewer bonus</span>
              <span class="siege-project-stats-metric">~${avgVoterStars.toFixed(1)}/5 ⭐ avg voter stars</span>
            </div>
          </div>
          <div class="siege-project-stats-footer">
            Week ${week} • ${hours.toFixed(1)}h spent • Unshipped
          </div>
          <div style="font-size: 0.6rem; font-weight: 500;">
            Projections based on your past efficiency. Estimates may be inaccurate.
          </div>
        </div>
      `;
    }

    let maxEfficiency;
    if (week <= 4) {
      maxEfficiency = 30;
    } else if (hours <= 10) {
      maxEfficiency = 7.5;
    } else {
      const maxFirst10 = 7.5;
      const maxAfter10 = 30;
      maxEfficiency = (10 * maxFirst10 + (hours - 10) * maxAfter10) / hours;
    }

    const percentage = Math.min((coinsPerHour / maxEfficiency) * 100, 100);
    const efficiencyColor = percentage >= 70 ? '#059669' : percentage >= 40 ? '#d97706' : '#dc2626';

    return `
      <div class="reviewer-feedback-container">
        <h3 class="reviewer-feedback-title">Project Stats</h3>
        <div class="reviewer-feedback-content siege-project-stats-content">
          <div class="siege-project-stats-row">
            <span class="siege-project-stats-metric" style="color: ${efficiencyColor};">${coinsPerHour.toFixed(1)} 🪙/hour</span>
            <span class="siege-project-stats-secondary">(top ${(100 - percentage).toFixed(0)}%)</span>
          </div>
          <div class="siege-project-stats-row">
            <span class="siege-project-stats-metric">~×${reviewerBonus.toFixed(2)} reviewer bonus</span>
            <span class="siege-project-stats-metric">~${avgScore}/5 ⭐ avg voter stars</span>
          </div>
        </div>
        <div class="siege-project-stats-footer">
          Week ${week} • ${hours.toFixed(1)}h total • ${totalCoins} 🪙 earned
        </div>
        <div style="font-size: 0.6rem; font-weight: 500;">
            Please do not fully trust the reviewer bonus & avg voter star estimates, it can be inaccurate.
          </div>
      </div>
    `;
  },

  getStoredTimeTracking() {
    const stored = localStorage.getItem('siege-utils-unshipped');
    const data = stored ? JSON.parse(stored) : {};
    return data;
  },

  saveTimeTracking(data) {
    localStorage.setItem('siege-utils-unshipped', JSON.stringify(data));
    goals.refreshMicroGoals();
  },

  trackProjectTime(projectId, currentHours, projectWeek = null) {

    const timeTracking = this.getStoredTimeTracking();
    const weekToUse = projectWeek || utils.getCurrentWeek();

    if (!timeTracking[projectId]) {
      timeTracking[projectId] = {
        firstSeen: new Date().toISOString(),
        week: weekToUse,
        initialHours: currentHours,
        snapshots: []
      };
    }

    const existingWeekSnapshot = timeTracking[projectId].snapshots.find(
      snapshot => snapshot.week === weekToUse
    );

    if (existingWeekSnapshot) {
      existingWeekSnapshot.hours = currentHours;
      existingWeekSnapshot.timestamp = new Date().toISOString();
    } else {
      timeTracking[projectId].snapshots.push({
        timestamp: new Date().toISOString(),
        hours: currentHours,
        week: weekToUse
      });
    }

    if (timeTracking[projectId].snapshots.length > 50) {
      timeTracking[projectId].snapshots = timeTracking[projectId].snapshots.slice(-50);
    }

    this.saveTimeTracking(timeTracking);
  },

  async sideloadProjectTime(projectId, { track = true } = {}) {
    try {
      const response = await fetch(`https://siege.hackclub.com/armory/${projectId}`, {
        headers: {
          'X-CSRF-Token': utils.getCSRFToken()
        }
      });

      if (!response.ok) {
        console.error(`Failed to fetch project ${projectId}: ${response.status} ${response.statusText}`);
        return;
      }


      const html = await response.text();
      const parser = new DOMParser();
      const doc = parser.parseFromString(html, 'text/html');

      const timeElement = doc.querySelector('.project-week-time');
      const titleElement = doc.querySelector('.projects-title');

      if (timeElement && titleElement) {
        const fullText = timeElement.textContent;
        const timeStr = fullText.replace('Time spent: ', '');
        const hours = this.parseTimeString(timeStr);
        const titleStr = titleElement.textContent;
        const week = this.parseWeek(titleStr);

        if (hours > 0) {
          if (track) {
            this.trackProjectTime(projectId, hours, week);
          }
          return hours;
        }
      }

      return null;

    } catch (error) {
      console.error(`Error sideloading project ${projectId}:`, error);
    }
  },

  getUnshippedTime(projectId) {
    const timeTracking = this.getStoredTimeTracking();
    const projectTracking = timeTracking[projectId];

    if (!projectTracking || projectTracking.snapshots.length === 0) {
      return 0;
    }

    const latestSnapshot = projectTracking.snapshots[projectTracking.snapshots.length - 1];
    const currentWeek = utils.getCurrentWeek();

    if (latestSnapshot.week === currentWeek) {
      return Math.max(0, latestSnapshot.hours - projectTracking.initialHours);
    }

    return 0;
  },

  getAverageEfficiency() {
    const stats = this.getStoredStats();
    const efficiencies = Object.values(stats)
      .map(project => project.coins_per_hour)
      .filter(efficiency => efficiency > 0);

    if (efficiencies.length === 0) return 12;

    const sum = efficiencies.reduce((acc, eff) => acc + eff, 0);
    return sum / efficiencies.length;
  },

  createProjectProjections(projectId, unshippedHours, week) {
    if (unshippedHours <= 0) return '';

    let efficiency;
    if (week >= 5) {
      efficiency = goals.getWeek5PlusEfficiency();
    } else {
      efficiency = this.getAverageEfficiency();
    }

    const projectedCoins = Math.round(unshippedHours * efficiency);

    return `
      <div class="siege-projections" style="
        margin-top: 1rem;
        padding: 0.75rem;
        background: rgba(59, 130, 246, 0.1);
        border: 1px solid rgba(59, 130, 246, 0.3);
        border-radius: 6px;
      ">
        <h4 style="margin: 0 0 0.5rem 0; font-size: 0.9rem; color: #1e40af;">📈 Projections</h4>
        <div style="font-size: 0.8rem;">
          <div>Unshipped time: <strong>${utils.formatHours(unshippedHours)}</strong></div>
          <div>Projected earnings: <strong>~${projectedCoins} 🪙</strong></div>
          <div style="opacity: 0.7; margin-top: 0.25rem;">
            Based on ${efficiency.toFixed(1)} 🪙/hour ${week >= 5 ? 'week 5+ efficiency' : 'average efficiency'}
          </div>
        </div>
      </div>
    `;
  }
};

const goals = {
  getStoredGoals() {
    const stored = localStorage.getItem('siege-utils-goals');
    return stored ? JSON.parse(stored) : [];
  },
  sideloadCache: new Map(),

  saveGoals(goals) {
    localStorage.setItem('siege-utils-goals', JSON.stringify(goals));
  },

  computeTimelineMeta() {
    const msInDay = 24 * 60 * 60 * 1000;
    const week3Start = new Date('2025-09-15');
    const programEnd = new Date(week3Start.getTime() + (14 - 3 + 1) * 7 * msInDay);
    const now = new Date();

    const rawDaysRemaining = (programEnd.getTime() - now.getTime()) / msInDay;
    const daysRemaining = rawDaysRemaining > 0 ? Math.ceil(rawDaysRemaining) : 0;
    const weeksRemaining = daysRemaining > 0 ? Math.max(1, Math.ceil(daysRemaining / 7)) : 0;

    const currentWeek = utils.getCurrentWeek();
    const clampedWeek = Math.min(Math.max(currentWeek, 3), 14);
    const weekStart = new Date(week3Start.getTime() + (clampedWeek - 3) * 7 * msInDay);
    const nextWeekStart = new Date(weekStart.getTime() + 7 * msInDay);

    let daysElapsedThisWeek = 0;
    if (now >= weekStart) {
      daysElapsedThisWeek = Math.min(7, Math.floor((now.getTime() - weekStart.getTime()) / msInDay) + 1);
    }
    if (daysElapsedThisWeek <= 0) {
      daysElapsedThisWeek = 1;
    }
    const daysRemainingThisWeek = Math.max(0, 7 - daysElapsedThisWeek);

    return {
      now: now.toISOString(),
      week3Start: week3Start.toISOString(),
      programEnd: programEnd.toISOString(),
      daysRemaining,
      weeksRemaining,
      currentWeek: clampedWeek,
      weekStart: weekStart.toISOString(),
      nextWeekStart: nextWeekStart.toISOString(),
      daysElapsedThisWeek,
      daysRemainingThisWeek
    };
  },

  getHoursSummary() {
    const shippedStats = projectStats.getStoredStats();
    const timeTracking = projectStats.getStoredTimeTracking();
    const currentWeek = utils.getCurrentWeek();

    let totalHours = 0;
    let currentWeekHours = 0;
    let todayHours = null;

    const TODAY_STORAGE_KEY = 'siege-utils-today-hours';
    const now = new Date();
    const todayKey = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
    try {
      const storedTodayData = JSON.parse(localStorage.getItem(TODAY_STORAGE_KEY));
      if (storedTodayData && storedTodayData.date === todayKey && Number.isFinite(storedTodayData.hours)) {
        todayHours = storedTodayData.hours;
      }
    } catch (error) {
      console.warn('[Siege Utils] Failed to read stored today hours:', error);
    }

    Object.values(shippedStats).forEach(project => {
      totalHours += project.hours || 0;
      if (project.week === currentWeek) {
        currentWeekHours += project.hours || 0;
      }
    });

    Object.keys(timeTracking).forEach(projectId => {
      const tracking = timeTracking[projectId];
      if (!tracking || !Array.isArray(tracking.snapshots) || tracking.snapshots.length === 0) return;

      const hasShippedData = Object.values(shippedStats).some(project =>
        project.projectId === projectId || `project_${projectId}` in shippedStats
      );
      if (hasShippedData) return;

      const weeklySnapshots = {};
      tracking.snapshots.forEach(snapshot => {
        if (!snapshot || typeof snapshot.week === 'undefined') return;
        if (!weeklySnapshots[snapshot.week]) {
          weeklySnapshots[snapshot.week] = [];
        }
        weeklySnapshots[snapshot.week].push(snapshot);
      });

      const weeks = Object.keys(weeklySnapshots)
        .map(num => parseInt(num, 10))
        .filter(Number.isFinite);

      if (weeks.length === 0) return;

      const latestWeek = Math.max(...weeks);
      const latestSnapshots = weeklySnapshots[latestWeek];
      const latestSnapshot = latestSnapshots[latestSnapshots.length - 1];

      if (latestSnapshot && Number.isFinite(latestSnapshot.hours)) {
        totalHours += latestSnapshot.hours;
      }

      if (weeklySnapshots[currentWeek]) {
        const currentSnapshots = weeklySnapshots[currentWeek];
        const currentSnapshot = currentSnapshots[currentSnapshots.length - 1];
        if (currentSnapshot && Number.isFinite(currentSnapshot.hours)) {
          currentWeekHours += currentSnapshot.hours;
        }
      }
    });

    if (typeof window !== 'undefined' && window.location.pathname === '/keep') {
      const siegeCheckrow = Array.from(document.querySelectorAll('.home-checkrow'))
        .find(el => el && typeof el.textContent === 'string' && /Siege!\s*\(/i.test(el.textContent));

      if (siegeCheckrow) {
        const siegeText = siegeCheckrow.textContent;
        const match = siegeText.match(/(\d+h\s*\d*m?)\s*\/?\s*\d*h?/i);
        if (match && match[1]) {
          const timeString = match[1].trim();
          const parsedHours = projectStats.parseTimeString(timeString);
          if (Number.isFinite(parsedHours)) {
            currentWeekHours = parsedHours;
          }
        }
      }

      const todayElement = Array.from(document.querySelectorAll('.home-progress-bottom, .home-progress-footer span, .home-progress-footer'))
        .find(el => el && typeof el.textContent === 'string' && /today you coded/i.test(el.textContent));

      if (todayElement) {
        const fullText = todayElement.textContent;
        const match = fullText.match(/today you coded\s+(\d+h\s*\d*m?|\d+m)/i);
        if (match && match[1]) {
          const timeString = match[1].trim();
          const parsedHours = projectStats.parseTimeString(timeString);
          if (Number.isFinite(parsedHours)) {
            todayHours = parsedHours;
            try {
              localStorage.setItem(TODAY_STORAGE_KEY, JSON.stringify({ date: todayKey, hours: parsedHours }));
            } catch (error) {
              console.warn('[Siege Utils] Failed to store today hours:', error);
            }
          }
        }
      }
    }

    return {
      totalHours,
      currentWeekHours,
      todayHours
    };
  },

  buildMicroGoalSnapshot() {
    const projectionData = this.getProjectionData();
    if (!projectionData) return null;

    const timeline = this.computeTimelineMeta();
    const hoursSummary = this.getHoursSummary();

    const totalUnshippedCoins = projectionData.projectedFromUnshipped || 0;
    const progress = this.getProgress();
    const remainingCoinsAfterProjected = Math.max(0, progress.total - progress.current - totalUnshippedCoins);

    const avgEfficiency = projectStats.getAverageEfficiency();
    const week5PlusEfficiency = this.getWeek5PlusEfficiency();
    const currentWeek = utils.getCurrentWeek();

    let adjustedHoursNeeded;
    if (currentWeek >= 5) {
      adjustedHoursNeeded = remainingCoinsAfterProjected / week5PlusEfficiency;
    } else {
      const prepWeeksRemaining = Math.max(0, 5 - currentWeek);
      const avgHoursPerWeek = 8;
      const hoursInRemainingPrepWeeks = prepWeeksRemaining * avgHoursPerWeek;
      const coinsFromPrepWeeks = hoursInRemainingPrepWeeks * avgEfficiency;
      const coinsNeededInWeek5Plus = Math.max(0, remainingCoinsAfterProjected - coinsFromPrepWeeks);
      const hoursNeededInWeek5Plus = coinsNeededInWeek5Plus / week5PlusEfficiency;
      adjustedHoursNeeded = hoursInRemainingPrepWeeks + hoursNeededInWeek5Plus;
    }

    const remainingHours = Math.max(0, adjustedHoursNeeded);

    const daysRemaining = Math.max(1, timeline.daysRemaining || 1);
    const weeksRemaining = Math.max(1, timeline.weeksRemaining || 1);

    const idealDailyTarget = remainingHours > 0 ? remainingHours / daysRemaining : 0;
    const targetDaily = Math.min(idealDailyTarget, 4);

    const targetWeekly = targetDaily * 7;

    const effectiveDaysElapsed = Math.max(1, Math.min(7, timeline.daysElapsedThisWeek || 1));
    const weeklyActual = hoursSummary.currentWeekHours || 0;
    let dailyActual = hoursSummary.todayHours;
    if (!Number.isFinite(dailyActual) || dailyActual < 0) {
      dailyActual = weeklyActual / effectiveDaysElapsed;
    }

    const weeklyPercentRaw = targetWeekly > 0 ? (weeklyActual / targetWeekly) * 100 : 0;
    const dailyPercentRaw = targetDaily > 0 ? (dailyActual / targetDaily) * 100 : 0;

    return {
      computedAt: new Date().toISOString(),
      remainingHours,
      remainingCoinsAfterProjected,
      targets: {
        daily: Number.isFinite(targetDaily) ? Number(targetDaily.toFixed(2)) : 0,
        weekly: Number.isFinite(targetWeekly) ? Number(targetWeekly.toFixed(2)) : 0
      },
      timeline,
      progress: {
        totalHoursTracked: Number((hoursSummary.totalHours || 0).toFixed(2)),
        weeklyActual: Number(weeklyActual.toFixed(2)),
        dailyActual: Number(dailyActual.toFixed(2)),
        weeklyPercent: Number.isFinite(weeklyPercentRaw) ? Number(Math.min(weeklyPercentRaw, 999).toFixed(1)) : 0,
        dailyPercent: Number.isFinite(dailyPercentRaw) ? Number(Math.min(dailyPercentRaw, 999).toFixed(1)) : 0,
        hoursRemainingThisWeek: Number(Math.max(0, targetWeekly - weeklyActual).toFixed(2)),
        dailyDelta: Number((targetDaily - dailyActual).toFixed(2))
      }
    };
  },

  refreshMicroGoals() {
    renderMicroGoalCard();
  },

  addGoal(item, autoAdded = false) {
    const goals = this.getStoredGoals();

    const existingGoal = goals.find(g => g.title === item.title);
    if (existingGoal) {
      return false;
    }

    const goal = {
      id: Date.now() + Math.random(),
      title: item.title,
      price: item.price,
      description: item.description,
      category: currentCategory,
      device: selectedDevice,
      requires: item.requires,
      autoAdded: autoAdded,
      dateAdded: new Date().toISOString()
    };

    goals.push(goal);

    if (item.requires && !autoAdded) {
      this.autoAddRequiredItems(item.requires, goals);
    }

    this.saveGoals(goals);
    userGoals = goals;
    this.refreshMicroGoals();
    return true;
  },

  autoAddRequiredItems(requiresText, currentGoals, processedItems = new Set()) {
    if (!techTreeData || !requiresText) return;

    if (processedItems.has(requiresText)) return;
    processedItems.add(requiresText);

    const requiredItems = this.findItemsByRequirement(requiresText);

    requiredItems.forEach(reqItem => {
      const alreadyInGoals = currentGoals.find(g => g.title === reqItem.title);
      if (!alreadyInGoals) {
        const reqGoal = {
          id: Date.now() + Math.random(),
          title: reqItem.title,
          price: reqItem.price,
          description: reqItem.description,
          category: reqItem.category,
          device: reqItem.device,
          requires: reqItem.requires,
          autoAdded: true,
          dateAdded: new Date().toISOString()
        };
        currentGoals.push(reqGoal);

        if (reqItem.requires) {
          this.autoAddRequiredItems(reqItem.requires, currentGoals, processedItems);
        }
      }
    });
  },

  findItemsByRequirement(requiresText) {
    const requiredItems = [];

    Object.keys(techTreeData).forEach(category => {
      if (techTreeData[category].branches) {
        Object.keys(techTreeData[category].branches).forEach(device => {
          const items = techTreeData[category].branches[device];
          Object.values(items).forEach(item => {
            if (item.title && requiresText.includes(item.title)) {
              requiredItems.push({ ...item, category, device });
            }
          });
        });
      }
    });

    return requiredItems;
  },

  removeGoal(goalId) {
    const goals = this.getStoredGoals();
    const goalToRemove = goals.find(g => g.id === goalId);

    if (!goalToRemove) return;

    let filteredGoals = goals.filter(g => g.id !== goalId);

    filteredGoals = this.cleanupOrphanedDependencies(filteredGoals);

    this.saveGoals(filteredGoals);
    userGoals = filteredGoals;
    this.refreshMicroGoals();
  },

  cleanupOrphanedDependencies(goals) {
    const manualGoals = goals.filter(g => !g.autoAdded);

    const neededRequirements = new Set();
    manualGoals.forEach(goal => {
      if (goal.requires) {
        this.collectAllRequirements(goal.requires, neededRequirements);
      }
    });

    const cleanedGoals = goals.filter(goal => {
      if (!goal.autoAdded) return true;
      return neededRequirements.has(goal.title);
    });

    return cleanedGoals;
  },

  collectAllRequirements(requiresText, neededSet, processedItems = new Set()) {
    if (!requiresText || processedItems.has(requiresText)) return;
    processedItems.add(requiresText);

    const requiredItems = this.findItemsByRequirement(requiresText);
    requiredItems.forEach(item => {
      neededSet.add(item.title);
      if (item.requires) {
        this.collectAllRequirements(item.requires, neededSet, processedItems);
      }
    });
  },

  getTotalCost() {
    const goals = this.getStoredGoals();
    return goals.reduce((total, goal) => total + goal.price, 0);
  },

  getProgress() {
    const totalCost = this.getTotalCost();
    if (totalCost === 0) return { current: 0, total: 0, percentage: 100 };

    const current = userCoins;
    const percentage = Math.min((current / totalCost) * 100, 100);

    return {
      current,
      total: totalCost,
      percentage: Math.round(percentage)
    };
  },

  getWeek5PlusEfficiency() {
    const shippedStats = projectStats.getStoredStats();
    const week5PlusProjects = Object.values(shippedStats).filter(project => project.week >= 5);

    const prepWeekProjects = Object.values(shippedStats).filter(project => project.week <= 4);

    if (week5PlusProjects.length > 0) {
      const projectsUnder10h = week5PlusProjects.filter(p => p.hours <= 10);
      const projectsOver10h = week5PlusProjects.filter(p => p.hours > 10);

      let week5First10Rate, week5After10Rate;

      if (projectsUnder10h.length > 0) {
        const totalCoins = projectsUnder10h.reduce((sum, p) => sum + p.total_coins, 0);
        const totalHours = projectsUnder10h.reduce((sum, p) => sum + p.hours, 0);
        week5First10Rate = totalCoins / totalHours;
      } else if (prepWeekProjects.length > 0) {
        const prepWeekEfficiency = prepWeekProjects.reduce((sum, p) => sum + p.coins_per_hour, 0) / prepWeekProjects.length;
        week5First10Rate = prepWeekEfficiency * 0.25;
      } else {
        const reviewerBonus = 2.0;
        const avgVoterStars = 3.0;
        week5First10Rate = 0.5 * reviewerBonus * avgVoterStars;
      }

      if (projectsOver10h.length > 0 && week5First10Rate) {
        let totalAfter10Coins = 0;
        let totalAfter10Hours = 0;
        projectsOver10h.forEach(p => {
          const first10Coins = 10 * week5First10Rate;
          const after10Coins = p.total_coins - first10Coins;
          const after10Hours = p.hours - 10;
          totalAfter10Coins += after10Coins;
          totalAfter10Hours += after10Hours;
        });
        week5After10Rate = totalAfter10Hours > 0 ? totalAfter10Coins / totalAfter10Hours : week5First10Rate;
      }

      if (week5First10Rate && week5After10Rate) {
        const avgHours = week5PlusProjects.reduce((sum, p) => sum + p.hours, 0) / week5PlusProjects.length;
        if (avgHours <= 10) {
          return week5First10Rate;
        } else {
          const first10Coins = 10 * week5First10Rate;
          const after10Coins = (avgHours - 10) * week5After10Rate;
          return (first10Coins + after10Coins) / avgHours;
        }
      }

      const totalWeek5PlusCoins = week5PlusProjects.reduce((sum, p) => sum + p.total_coins, 0);
      const totalWeek5PlusHours = week5PlusProjects.reduce((sum, p) => sum + p.hours, 0);
      return totalWeek5PlusHours > 0 ? totalWeek5PlusCoins / totalWeek5PlusHours : 0;
    }

    const avgPrepHours = prepWeekProjects.length > 0
      ? prepWeekProjects.reduce((sum, p) => sum + p.hours, 0) / prepWeekProjects.length
      : 10;
    const predictedWeeklyHours = Math.max(avgPrepHours, 10);

    let week5First10Rate, week5After10Rate;
    if (prepWeekProjects.length > 0) {
      const prepWeekEfficiency = prepWeekProjects.reduce((sum, p) => sum + p.coins_per_hour, 0) / prepWeekProjects.length;
      week5First10Rate = prepWeekEfficiency * 0.25;
      week5After10Rate = prepWeekEfficiency;
    } else {
      const reviewerBonus = 2.0;
      const avgVoterStars = 3.0;
      week5First10Rate = 0.5 * reviewerBonus * avgVoterStars;
      week5After10Rate = 2.0 * reviewerBonus * avgVoterStars;
    }

    let totalCoins;
    if (predictedWeeklyHours <= 10) {
      totalCoins = predictedWeeklyHours * week5First10Rate;
    } else {
      const first10Coins = 10 * week5First10Rate;
      const remainingCoins = (predictedWeeklyHours - 10) * week5After10Rate;
      totalCoins = first10Coins + remainingCoins;
    }

    return totalCoins / predictedWeeklyHours;
  },

  estimateTimeForItem(itemPrice, currentCoins) {
    const shippedStats = projectStats.getStoredStats();
    const avgEfficiency = projectStats.getAverageEfficiency();
    const week5PlusEfficiency = this.getWeek5PlusEfficiency();

    const allWeeklyHours = {};
    Object.values(shippedStats).forEach(project => {
      if (!allWeeklyHours[project.week]) allWeeklyHours[project.week] = 0;
      allWeeklyHours[project.week] += project.hours;
    });

    const calculateTimeFromZero = (coins) => {
      const week1to4Projects = Object.values(shippedStats).filter(project => project.week <= 4);
      const coinsFromWeek1to4 = week1to4Projects.reduce((sum, p) => sum + p.total_coins, 0);

      const coinsStillNeeded = Math.max(0, coins - coinsFromWeek1to4);

      if (coinsStillNeeded === 0) {
        return coins / avgEfficiency;
      }

      const timeForWeek1to4Coins = coinsFromWeek1to4 > 0 ? coinsFromWeek1to4 / avgEfficiency : 0;
      const timeForWeek5PlusCoins = coinsStillNeeded / week5PlusEfficiency;

      return timeForWeek1to4Coins + timeForWeek5PlusCoins;
    };

    const totalTime = calculateTimeFromZero(itemPrice);
    const remainingNeeded = Math.max(0, itemPrice - currentCoins);
    const timeNeeded = remainingNeeded > 0 ? calculateTimeFromZero(remainingNeeded) : 0;

    return {
      totalHours: totalTime,
      totalTime: utils.formatHours(totalTime),
      neededHours: timeNeeded,
      timeNeeded: utils.formatHours(timeNeeded)
    };
  },

  getProjectionData() {
    const progress = this.getProgress();
    const avgEfficiency = projectStats.getAverageEfficiency();
    const currentWeek = utils.getCurrentWeek();
    const remainingCoins = Math.max(0, progress.total - progress.current);

    const week5PlusEfficiency = this.getWeek5PlusEfficiency();

    let totalHoursNeeded;

    if (currentWeek >= 5) {
      totalHoursNeeded = remainingCoins / week5PlusEfficiency;
    } else {

      const prepWeeksRemaining = Math.max(0, 5 - currentWeek);

      const timeTracking = projectStats.getStoredTimeTracking();
      const shippedStats = projectStats.getStoredStats();
      let avgHoursPerWeek = 8;

      const allWeeklyHours = {};
      Object.values(shippedStats).forEach(project => {
        if (!allWeeklyHours[project.week]) allWeeklyHours[project.week] = 0;
        allWeeklyHours[project.week] += project.hours;
      });

      Object.keys(timeTracking).forEach(projectId => {
        const tracking = timeTracking[projectId];
        if (tracking.snapshots && tracking.snapshots.length > 0) {
          const hasShippedData = Object.values(shippedStats).some(project =>
            project.projectId === projectId || `project_${projectId}` in shippedStats
          );
          if (!hasShippedData) {
            tracking.snapshots.forEach(snapshot => {
              if (!allWeeklyHours[snapshot.week]) allWeeklyHours[snapshot.week] = 0;
              allWeeklyHours[snapshot.week] += snapshot.hours;
            });
          }
        }
      });

      const weeklyHoursValues = Object.values(allWeeklyHours).filter(h => h > 0);
      if (weeklyHoursValues.length > 0) {
        avgHoursPerWeek = weeklyHoursValues.reduce((sum, h) => sum + h, 0) / weeklyHoursValues.length;
      }
      const hoursInRemainingPrepWeeks = prepWeeksRemaining * avgHoursPerWeek;
      const coinsFromRemainingPrepWeeks = hoursInRemainingPrepWeeks * avgEfficiency;

      const coinsNeededInWeek5Plus = Math.max(0, remainingCoins - coinsFromRemainingPrepWeeks);
      const hoursNeededInWeek5Plus = coinsNeededInWeek5Plus / week5PlusEfficiency;

      totalHoursNeeded = hoursInRemainingPrepWeeks + hoursNeededInWeek5Plus;
    }

    const effectiveEfficiency = remainingCoins / totalHoursNeeded;

    const timeTracking = projectStats.getStoredTimeTracking();
    let totalUnshippedTime = 0;
    let totalUnshippedCoins = 0;

    Object.keys(timeTracking).forEach(projectId => {
      const tracking = timeTracking[projectId];
      if (tracking.snapshots && tracking.snapshots.length > 0) {
        const shippedStats = projectStats.getStoredStats();
        const hasShippedData = Object.values(shippedStats).some(project =>
          project.projectId === projectId || `project_${projectId}` in shippedStats
        );

        if (!hasShippedData) {
          const latest = tracking.snapshots[tracking.snapshots.length - 1];
          const hours = latest.hours;
          const projectWeek = latest.week || currentWeek;

          let efficiency;
          if (projectWeek >= 5) {
            efficiency = week5PlusEfficiency;
          } else {
            efficiency = avgEfficiency;
          }

          const projectedCoins = Math.round(hours * efficiency);

          totalUnshippedTime += hours;
          totalUnshippedCoins += projectedCoins;
        }
      }
    });

    const projectedFromUnshipped = totalUnshippedCoins;
    const remainingAfterUnshipped = Math.max(0, remainingCoins - projectedFromUnshipped);
    const additionalHoursNeeded = remainingAfterUnshipped > 0 && effectiveEfficiency > 0
      ? remainingAfterUnshipped / effectiveEfficiency
      : 0;
    const projectedTotal = progress.current + projectedFromUnshipped;
    const projectedPercentage = Math.min((projectedTotal / progress.total) * 100, 100);

    return {
      totalHoursNeeded,
      totalUnshippedTime,
      projectedFromUnshipped,
      remainingAfterUnshipped,
      additionalHoursNeeded,
      projectedPercentage: Math.round(projectedPercentage)
    };
  },

  createMicroGoalSection() {
    const storedGoals = this.getStoredGoals();
    if (!storedGoals || storedGoals.length === 0) {
      return '';
    }

    const snapshot = this.buildMicroGoalSnapshot();

    if (!snapshot) {
      return `
        <div data-siege-microgoal-inline="true" style="margin-top: 1rem; text-align: center; font-size: 0.85rem; color: rgba(59, 42, 26, 0.7);">
          Add at least one goal to unlock micro goal planning.
        </div>
      `;
    }

    const formatNumber = (value, digits = 1) => {
      if (!Number.isFinite(value)) return '0';
      return Number(value).toFixed(digits);
    };

    const safeNumber = (value) => (Number.isFinite(value) ? value : 0);

    const dailyTarget = safeNumber(snapshot.targets.daily);
    const weeklyTarget = safeNumber(snapshot.targets.weekly);
    const dailyActual = safeNumber(snapshot.progress.dailyActual);
    const weeklyActual = safeNumber(snapshot.progress.weeklyActual);
    const dailyRemaining = Math.max(0, dailyTarget - dailyActual);
    const weeklyRemaining = Math.max(0, weeklyTarget - weeklyActual);

    const tile = (label, target, actual, remaining, accent) => {
      const remainingLabel = remaining <= 0
        ? 'Goal met'
        : `${formatNumber(remaining, 1)}h remaining`;

      return `
        <div style="
          flex: 1 1 220px;
          min-width: 200px;
          background: rgba(255, 255, 255, 0.7);
          border: 1px solid rgba(64, 43, 32, 0.18);
          border-radius: 0.75rem;
          padding: 0.85rem;
        ">
          <div style="font-size: 0.75rem; font-weight: 600; text-transform: uppercase; letter-spacing: 0.04em; color: ${accent};">
            ${label}
          </div>
          <div style="font-size: 1.05rem; font-weight: 600; color: #2f2014; margin-top: 0.4rem;">
            Target ${formatNumber(target, 1)}h
          </div>
          <div style="font-size: 0.78rem; color: rgba(59, 42, 26, 0.75); margin-top: 0.4rem;">
            Logged ${formatNumber(actual, 1)}h
          </div>
          <div style="font-size: 0.75rem; color: rgba(59, 42, 26, 0.75); margin-top: 0.35rem;">
            ${remainingLabel}
          </div>
        </div>
      `;
    };

    return `
      <div data-siege-microgoal-inline="true" style="margin-top: 1.1rem; display: flex; flex-wrap: wrap; gap: 0.85rem; justify-content: center;">
        ${tile('Daily goal', dailyTarget, dailyActual, dailyRemaining, '#059669')}
        ${tile('Weekly goal', weeklyTarget, weeklyActual, weeklyRemaining, '#2563eb')}
      </div>
    `;
  },

  createProgressBar() {
    const progress = this.getProgress();
    const goals = this.getStoredGoals();

    if (goals.length === 0) return '';

    const projectionData = this.getProjectionData();
    const microGoalsHTML = this.createMicroGoalSection();
    return `
      <div class="siege-goals-progress" style="
        margin: 1rem 0;
        padding: 1.25rem;
        background: rgba(64, 43, 32, 0.1);
        border: 2px solid rgba(64, 43, 32, 0.3);
        border-radius: 8px;
      ">
        <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 1rem;">
          <h3 style="margin: 0; font-size: 1.1rem; font-weight: 600;">Goals Progress</h3>
          <div style="display: flex; gap: 0.5rem;">
            <button class="siege-progress-tab active" data-tab="current" style="
              padding: 0.35rem 0.75rem;
              border: 1px solid rgba(64, 43, 32, 0.5);
              background: rgba(64, 43, 32, 0.2);
              color: #374151;
              border-radius: 6px;
              font-size: 0.85rem;
              font-weight: 500;
              cursor: pointer;
              transition: all 0.2s ease;
            ">Current</button>
            <button class="siege-progress-tab" data-tab="projected" style="
              padding: 0.35rem 0.75rem;
              border: 1px solid rgba(64, 43, 32, 0.3);
              background: transparent;
              color: #6b7280;
              border-radius: 6px;
              font-size: 0.85rem;
              font-weight: 500;
              cursor: pointer;
              transition: all 0.2s ease;
            ">Projected</button>
          </div>
        </div>

        <div class="siege-progress-content" id="current-content">
          <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 0.75rem;">
            <span style="font-size: 1.3rem; font-weight: 600;">${utils.formatCoins(progress.current)} / ${utils.formatCoins(progress.total)}</span>
            <span style="font-size: 1.1rem; font-weight: 500; color: #059669;">${progress.percentage}%</span>
          </div>
          <div style="
            width: 100%;
            height: 24px;
            background: linear-gradient(145deg, #f8f9fa, #e9ecef);
            border: 1px solid rgba(64, 43, 32, 0.2);
            border-radius: 12px;
            margin-bottom: 0.75rem;
            position: relative;
            box-shadow: inset 0 2px 4px rgba(0, 0, 0, 0.1);
          ">
            <div style="
              width: ${Math.max(2, progress.percentage)}%;
              height: calc(100% - 4px);
              background: linear-gradient(145deg, #10b981, #059669);
              border-radius: 10px;
              margin: 2px;
              position: absolute;
              left: 0;
              top: 0;
              box-shadow: 0 1px 3px rgba(5, 150, 105, 0.3);
              transition: all 0.3s ease;
            "></div>
          </div>
          <div style="font-size: 1.1rem; opacity: 0.85; text-align: center;">
            ${goals.length} goal${goals.length !== 1 ? 's' : ''} • ${utils.formatCoins(Math.max(0, progress.total - progress.current))} remaining • ${utils.formatHours(projectionData.totalHoursNeeded)} needed
          </div>
        </div>

        <div class="siege-progress-content" id="projected-content" style="display: none;">
          <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 0.75rem;">
            <span style="font-size: 1.3rem; font-weight: 600;">
              ${utils.formatCoins(progress.current + projectionData.projectedFromUnshipped)} / ${utils.formatCoins(progress.total)}
            </span>
            <span style="font-size: 1.1rem; font-weight: 500; color: #60a5fa;">${projectionData.projectedPercentage}%</span>
          </div>
          <div style="
            width: 100%;
            height: 24px;
            background: linear-gradient(145deg, #f8f9fa, #e9ecef);
            border: 1px solid rgba(64, 43, 32, 0.2);
            border-radius: 12px;
            margin-bottom: 0.75rem;
            position: relative;
            box-shadow: inset 0 2px 4px rgba(0, 0, 0, 0.1);
          ">
            <div style="
              width: ${Math.max(2, progress.percentage)}%;
              height: calc(100% - 4px);
              background: linear-gradient(145deg, #10b981, #059669);
              border-radius: ${projectionData.projectedPercentage > progress.percentage ? '10px 0 0 10px' : '10px'};
              margin: 2px ${projectionData.projectedPercentage > progress.percentage ? '0' : '2px'} 2px 2px;
              position: absolute;
              left: 0;
              top: 0;
              box-shadow: 0 1px 3px rgba(5, 150, 105, 0.3);
              transition: all 0.3s ease;
            "></div>
            ${projectionData.projectedPercentage > progress.percentage ? `
            <div style="
              width: ${projectionData.projectedPercentage - progress.percentage}%;
              height: calc(100% - 4px);
              background: linear-gradient(145deg, #60a5fa, #3b82f6);
              border-radius: 0 10px 10px 0;
              margin: 2px 2px 2px 0;
              position: absolute;
              left: ${progress.percentage}%;
              top: 0;
              box-shadow: 0 1px 3px rgba(59, 130, 246, 0.3);
              transition: all 0.3s ease;
            "></div>
            ` : ''}
          </div>
          <div style="font-size: 1.1rem; opacity: 0.85; text-align: center;">
            ${goals.length} goal${goals.length !== 1 ? 's' : ''} • ${utils.formatCoins(projectionData.remainingAfterUnshipped)} remaining • ${utils.formatHours(projectionData.additionalHoursNeeded)} needed
          </div>
        </div>
        ${microGoalsHTML}
      </div>
    `;
  },

  createGoalButton(item) {
    const goals = this.getStoredGoals();
    const hasGoal = goals.find(g => g.title === item.title);

    const buttonText = hasGoal ? 'Remove Goal' : 'Add Goal';
    const buttonClass = hasGoal ? 'siege-goal-button-remove' : 'siege-goal-button-add';

    return `
      <button class="siege-goal-button ${buttonClass}" data-action="${hasGoal ? 'remove' : 'add'}" data-goal-id="${hasGoal ? hasGoal.id : ''}" style="
        padding: 0.4rem 0.8rem;
        border: 1px solid ${hasGoal ? '#dc2626' : '#059669'};
        background: ${hasGoal ? 'rgba(220, 38, 38, 0.1)' : 'rgba(5, 150, 105, 0.1)'};
        color: ${hasGoal ? '#dc2626' : '#059669'};
        border-radius: 4px;
        font-size: 0.8rem;
        font-weight: 500;
        cursor: pointer;
        transition: all 0.2s ease;
        margin-top: 0.5rem;
        width: 100%;
      ">
        ${buttonText}
      </button>
    `;
  }
};

const routePlanner = {

  createSidebar() {
    const cardStateClass = isRouteCollapsed ? 'collapsed' : 'expanded';
    const expanded = (!isRouteCollapsed).toString();
    return `
      <aside class="siege-route-sidebar">
        <div class="siege-route-card ${cardStateClass}">
          <div class="siege-route-header">
            <h3>Upgrade Route</h3>
            <button type="button" class="siege-route-toggle" data-route-toggle aria-expanded="${expanded}" aria-label="Toggle upgrade route">
              <span class="siege-route-toggle-icon">${isRouteCollapsed ? '▸' : '▾'}</span>
            </button>
          </div>
          <div class="siege-route-body">
            <p class="siege-route-subtitle">Select an upgrade to map prerequisites.</p>
            <div class="siege-route-summary" data-route-summary></div>
            <div class="siege-route-diagram" data-route-container>
              <div class="siege-route-placeholder">
                Pick an upgrade from the grid to preview its route.
              </div>
            </div>
            <div class="siege-route-tooltip" data-route-tooltip style="display: none;"></div>
          </div>
        </div>
      </aside>
    `;
  },

  normalizePrice(value) {
    if (typeof value === 'number' && Number.isFinite(value)) {
      return value;
    }
    if (typeof value === 'string') {
      const cleaned = value.replace(/[^\d.]/g, '');
      const parsed = parseFloat(cleaned);
      return Number.isFinite(parsed) ? parsed : 0;
    }
    return 0;
  },

  computeDepth(item, category, device, cache = new Map(), stack = new Set()) {
    if (!item) return 0;
    const key = this.getItemKey(item, category, device);
    if (!key) return 0;
    if (cache.has(key)) return cache.get(key);
    if (stack.has(key)) return 0;

    stack.add(key);
    const requirements = this.getRequirementItems(item, category, device);
    if (!requirements.length) {
      cache.set(key, 0);
      stack.delete(key);
      return 0;
    }

    let maxDepth = 0;
    requirements.forEach((req) => {
      const depth = this.computeDepth(req, category, device, cache, stack);
      if (depth > maxDepth) {
        maxDepth = depth;
      }
    });

    stack.delete(key);
    cache.set(key, maxDepth + 1);
    return maxDepth + 1;
  },

  findDeepestUpgrade(category, device) {
    const branch = techTreeData?.[category]?.branches?.[device];
    if (!branch) return null;

    const items = Object.values(branch);
    if (!items.length) return null;

    const cache = new Map();
    let best = null;

    items.forEach((rawItem) => {
      if (!rawItem.requires) return;
      const enriched = this.enrichItemWithBranchData(rawItem, category, device);
      if (!enriched) return;

      const depth = this.computeDepth(enriched, category, device, cache);
      const price = this.normalizePrice(enriched.price);

      if (!best || depth > best.depth || (depth === best.depth && price > best.price)) {
        best = { item: enriched, depth, price };
      }
    });

    if (best) {
      return best.item;
    }

    let fallback = null;
    items.forEach((rawItem) => {
      const enriched = this.enrichItemWithBranchData(rawItem, category, device);
      if (!enriched) return;
      const price = this.normalizePrice(enriched.price);
      if (!fallback || price > fallback.price) {
        fallback = { item: enriched, price };
      }
    });

    return fallback ? fallback.item : null;
  },

  ensureDefaultRoute(category, device) {
    if (!category || !device) return;
    if (!techTreeData?.[category]?.branches?.[device]) return;

    if (currentRouteItem &&
      currentRouteItem.category === category &&
      currentRouteItem.device === device) {
      return;
    }

    const defaultItem = this.findDeepestUpgrade(category, device);
    if (defaultItem) {
      this.setCurrentRoute({ item: defaultItem, category, device });
    }
  },

  handleContextChange(category, device) {
    if (!currentRouteItem) {
      return;
    }

    const existingCategory = currentRouteItem.category || currentRouteItem.item?.category;
    const existingDevice = currentRouteItem.device || currentRouteItem.item?.device;

    if (existingCategory !== category || existingDevice !== device) {
      currentRouteItem = null;
    }
  },

  setCurrentRoute({ item, category, device }) {
    if (!item) {
      return;
    }

    const effectiveCategory = category || item.category || currentCategory;
    const effectiveDevice = device || item.device || selectedDevice;

    if (!effectiveCategory || !effectiveDevice) {
      currentRouteItem = null;
      return;
    }

    const enrichedItem = this.enrichItemWithBranchData(item, effectiveCategory, effectiveDevice);
    if (!enrichedItem) {
      currentRouteItem = null;
      return;
    }

    const newRoute = {
      item: enrichedItem,
      category: effectiveCategory,
      device: effectiveDevice
    };

    if (comparisonMode && currentRouteItem && !comparisonRouteItem) {
      if (currentRouteItem.item.title !== enrichedItem.title) {
        comparisonRouteItem = newRoute;
        components.showToast(`Comparing: ${currentRouteItem.item.title} vs ${enrichedItem.title}`, 3000);
      }
    } else {
      currentRouteItem = newRoute;
    }
  },

  resetRoute() {
    currentRouteItem = null;
  },

  getItemKey(item, categoryOverride, deviceOverride) {
    if (!item || !item.title) {
      return null;
    }
    const category = item.category || categoryOverride || '';
    const device = item.device || deviceOverride || '';
    return `${category}::${device}::${item.title}`;
  },

  enrichItemWithBranchData(item, category, device) {
    if (!item) {
      return null;
    }

    const effectiveCategory = category || item.category;
    const effectiveDevice = device || item.device;

    const branch = techTreeData?.[effectiveCategory]?.branches?.[effectiveDevice];
    if (branch) {
      const match = Object.values(branch).find((branchItem) => branchItem.title === item.title);
      if (match) {
        const normalizedPrice = this.normalizePrice(match.price ?? match.cost ?? match.value);
        return {
          ...match,
          price: normalizedPrice,
          category: effectiveCategory,
          device: effectiveDevice
        };
      }
    }

    const fallbackPrice = this.normalizePrice(item.price ?? item.cost ?? item.value);
    return {
      ...item,
      price: fallbackPrice,
      category: effectiveCategory,
      device: effectiveDevice
    };
  },

  getRequirementItems(item, category, device) {
    if (!item || !item.requires || !techTreeData) {
      return [];
    }

    const matches = goals.findItemsByRequirement(item.requires);
    if (!matches || matches.length === 0) {
      return [];
    }

    const unique = new Map();

    matches.forEach((match) => {
      const matchCategory = match.category || category;
      const matchDevice = match.device || device;

      if (category && matchCategory && matchCategory !== category) return;
      if (device && matchDevice && matchDevice !== device) return;

      const enriched = this.enrichItemWithBranchData(match, matchCategory, matchDevice);
      const key = this.getItemKey(enriched, matchCategory, matchDevice);

      if (!key || unique.has(key)) return;

      unique.set(key, enriched);
    });

    return Array.from(unique.values());
  },

  getBaseDeviceOption(category, device) {
    if (!techTreeData || !techTreeData[category]) {
      return null;
    }

    const initialNode = techTreeData[category].initialNode;
    if (!initialNode) {
      return null;
    }

    const formatItem = (item) => {
      if (!item) return null;
      return {
        title: item.title || item.name || '',
        price: item.price ?? item.cost ?? item.value ?? 0,
        description: item.description || '',
        category,
        device,
        requires: '',
        isBase: true
      };
    };

    if (initialNode.id && initialNode.id === device) {
      return formatItem(initialNode);
    }

    if (Array.isArray(initialNode.options)) {
      const match = initialNode.options.find(option => option.id === device);
      if (match) {
        return formatItem(match);
      }
    }

    return null;
  },

  buildGraph(context) {
    if (!context || !context.item) {
      return {
        nodes: [],
        edges: [],
        totalCost: 0,
        ownedCost: 0,
        neededCost: 0,
        targetTitle: ''
      };
    }

    const category = context.category || context.item.category || currentCategory;
    const device = context.device || context.item.device || selectedDevice;

    if (!category || !device || !techTreeData?.[category]?.branches?.[device]) {
      return {
        nodes: [],
        edges: [],
        totalCost: 0,
        ownedCost: 0,
        neededCost: 0,
        targetTitle: context.item.title || ''
      };
    }

    const targetItem = this.enrichItemWithBranchData(context.item, category, device);
    const targetKey = this.getItemKey(targetItem, category, device);

    const nodesMap = new Map();
    const edges = [];
    const visited = new Set();

    const traverse = (rawItem, depth = 0) => {
      if (!rawItem) return;

      const normalized = this.enrichItemWithBranchData(rawItem, category, device);
      const key = this.getItemKey(normalized, category, device);
      if (!key) return;

      if (!nodesMap.has(key)) {
        nodesMap.set(key, {
          key,
          item: normalized,
          depth
        });
      } else {
        const existing = nodesMap.get(key);
        existing.depth = Math.max(existing.depth, depth);
      }

      if (visited.has(key)) return;
      visited.add(key);

      const requirements = this.getRequirementItems(normalized, category, device);
      if (!requirements.length) return;

      requirements.forEach((req) => {
        const enrichedReq = this.enrichItemWithBranchData(req, category, device);
        const reqKey = this.getItemKey(enrichedReq, category, device);
        if (!reqKey) return;

        edges.push({ from: reqKey, to: key });
        traverse(enrichedReq, depth + 1);
      });
    };

    traverse(targetItem, 0);

    let maxDepthRecorded = 0;
    nodesMap.forEach((entry) => {
      if (entry.depth > maxDepthRecorded) {
        maxDepthRecorded = entry.depth;
      }
    });

    const incomingCount = new Map();
    edges.forEach(edge => {
      incomingCount.set(edge.to, (incomingCount.get(edge.to) || 0) + 1);
    });

    const baseOption = this.getBaseDeviceOption(category, device);
    if (baseOption) {
      const baseKey = this.getItemKey(baseOption, category, device) || `base::${category}::${device}`;
      if (!nodesMap.has(baseKey)) {
        nodesMap.set(baseKey, {
          key: baseKey,
          item: baseOption,
          depth: maxDepthRecorded + 1,
          isBase: true
        });

        nodesMap.forEach((entry, key) => {
          if (key === baseKey) return;
          if (!incomingCount.has(key)) {
            edges.push({ from: baseKey, to: key });
            incomingCount.set(key, 1);
          }
        });
      }
    }

    const nodes = Array.from(nodesMap.values()).map((entry) => {
      const isBase = Boolean(entry.isBase);
      const normalizedPrice = this.normalizePrice(entry.item.price);
      const owned = isBase ? true : utils.isPurchased(entry.item.title);
      const affordable = !isBase && !owned && utils.canAfford(normalizedPrice);
      const statusClass = isBase ? 'base' : (owned ? 'owned' : (affordable ? 'affordable' : 'locked'));

      return {
        ...entry,
        price: normalizedPrice,
        owned,
        statusClass,
        statusText: '',
        isBase,
        isTarget: entry.key === targetKey
      };
    });

    const nodesForTotals = nodes.filter(node => !node.isBase);
    const totalCost = nodesForTotals.reduce((sum, node) => sum + (Number.isFinite(node.price) ? node.price : 0), 0);
    const ownedCost = nodesForTotals.reduce((sum, node) => sum + (node.owned ? node.price : 0), 0);
    const neededCost = Math.max(0, totalCost - ownedCost);

    const nextStep = this.findNextStep(nodes, edges);
    if (nextStep) {
      const nextNode = nodes.find(n => n.key === nextStep.key);
      if (nextNode) {
        nextNode.isNextStep = true;
      }
    }

    return {
      nodes,
      edges,
      totalCost,
      ownedCost,
      neededCost,
      targetTitle: targetItem.title,
      category,
      device,
      nextStep
    };
  },

  findNextStep(nodes, edges) {
    const candidates = nodes.filter(node => {
      if (node.isBase || node.owned) return false;

      const prerequisites = edges.filter(edge => edge.to === node.key);

      const allPrereqsOwned = prerequisites.every(edge => {
        const prereqNode = nodes.find(n => n.key === edge.from);
        return prereqNode && (prereqNode.owned || prereqNode.isBase);
      });

      return allPrereqsOwned;
    });

    if (candidates.length === 0) return null;

    const affordable = candidates.filter(c => c.statusClass === 'affordable');
    if (affordable.length > 0) {
      affordable.sort((a, b) => {
        if (a.depth !== b.depth) return b.depth - a.depth;
        return a.price - b.price;
      });
      return affordable[0];
    }

    candidates.sort((a, b) => a.price - b.price);
    return candidates[0];
  },

  buildNodeLabel(node) {
    const title = utils.escapeHtml(node.item.title);
    const coinsValue = Number.isFinite(node.price) ? Math.round(node.price) : 0;
    const coinsText = utils.escapeHtml(utils.formatCoins(coinsValue));
    const status = utils.escapeHtml(node.statusText);

    return `${title}<br/>${coinsText}<br/>${status}`;
  },

  buildDiagram(graph) {
    if (!graph.nodes.length) {
      return '';
    }

    const lines = ['flowchart TB'];
    const sortedNodes = [...graph.nodes].sort((a, b) => b.depth - a.depth);
    const idMap = new Map();

    sortedNodes.forEach((node, index) => {
      const nodeId = `routeNode_${index}`;
      idMap.set(node.key, nodeId);
      const safeLabel = this.buildNodeLabel(node).replace(/"/g, '\\"');
      lines.push(`${nodeId}["${safeLabel}"]`);
    });

    graph.edges.forEach((edge) => {
      const fromId = idMap.get(edge.from);
      const toId = idMap.get(edge.to);
      if (fromId && toId) {
        lines.push(`${fromId} --> ${toId}`);
      }
    });

    lines.push('classDef owned fill:#f2fce2,stroke:#4d7c0f,stroke-width:2px,color:#365314;');
    lines.push('classDef affordable fill:#fff3d6,stroke:#d97706,stroke-width:2px,color:#92400e;');
    lines.push('classDef locked fill:#fde2e4,stroke:#be123c,stroke-width:2px,color:#9f1239;');
    lines.push('classDef target stroke:#2563eb,stroke-width:3px;');
    lines.push('classDef sketch fill:#fff9ed,stroke:#8b5a2b,stroke-width:1.5px,color:#422006;');

    sortedNodes.forEach((node) => {
      const nodeId = idMap.get(node.key);
      if (!nodeId) return;

      const classNames = ['sketch', node.statusClass];
      if (node.isTarget) {
        classNames.push('target');
      }
      const uniqueClasses = [...new Set(classNames.filter(Boolean))];
      if (uniqueClasses.length > 0) {
        lines.push(`class ${nodeId} ${uniqueClasses.join(',')}`);
      }
    });

    return lines.join('\n');
  },

  buildSvgDiagram(graph) {
    if (!graph.nodes.length) {
      return this.buildTextFallback(graph);
    }

    const nodes = graph.nodes.map(node => ({ ...node }));
    const maxDepth = nodes.reduce((acc, node) => Math.max(acc, node.depth), 0);
    const levels = Array.from({ length: maxDepth + 1 }, () => []);

    nodes.forEach(node => {
      const level = maxDepth - node.depth;
      node.level = level;
      levels[level].push(node);
    });

    const nodeWidth = 240;
    const nodeHeight = 100;
    const horizontalGap = 44;
    const verticalGap = 118;
    const paddingX = 32;
    const paddingY = 44;

    const levelWidths = levels.map(levelNodes => {
      const count = levelNodes.length || 1;
      return count * nodeWidth + (count - 1) * horizontalGap;
    });

    const maxRowWidth = Math.max(...levelWidths, nodeWidth);
    const svgWidth = paddingX * 2 + maxRowWidth;
    const svgHeight = paddingY * 2 + (levels.length > 0
      ? levels.length * nodeHeight + (levels.length - 1) * verticalGap
      : nodeHeight + verticalGap);

    levels.forEach((levelNodes, levelIndex) => {
      levelNodes.sort((a, b) => a.item.title.localeCompare(b.item.title));
      const levelWidth = levelWidths[levelIndex] || nodeWidth;
      const startX = paddingX + (maxRowWidth - levelWidth) / 2;
      levelNodes.forEach((node, index) => {
        node.x = startX + index * (nodeWidth + horizontalGap);
        node.y = paddingY + levelIndex * (nodeHeight + verticalGap);
      });
    });

    const nodeByKey = new Map();
    nodes.forEach(node => {
      nodeByKey.set(node.key, node);
    });

    const edgePaths = graph.edges.map(edge => {
      const from = nodeByKey.get(edge.from);
      const to = nodeByKey.get(edge.to);
      if (!from || !to) return '';
      const startX = from.x + nodeWidth / 2;
      const startY = from.y + nodeHeight;
      const endX = to.x + nodeWidth / 2;
      const endY = to.y;
      const midY = (startY + endY) / 2;
      return `<path d="M ${startX} ${startY} C ${startX} ${midY}, ${endX} ${midY}, ${endX} ${endY}" class="siege-route-edge" marker-end="url(#siege-route-arrow)" />`;
    }).join('');

    const nodeBlocks = nodes.map(node => {
      const title = utils.escapeHtml(node.item.title);
      const coinsValue = Number.isFinite(node.price) ? Math.round(node.price) : 0;
      const hasCoinLine = !node.isBase && coinsValue > 0;
      const coinsText = hasCoinLine ? utils.escapeHtml(utils.formatCoins(coinsValue)) : '';
      const classes = ['siege-route-node', node.statusClass];
      if (node.isTarget) {
        classes.push('target');
      }
      if (node.isNextStep) {
        classes.push('next-step');
      }

      const titleY = hasCoinLine ? 42 : (nodeHeight / 2);
      const titleBaseline = hasCoinLine ? '' : 'dominant-baseline="middle"';
      const coinLine = hasCoinLine
        ? `<text x="${nodeWidth / 2}" y="${nodeHeight - 24}" class="siege-route-node-coins">${coinsText}</text>`
        : '';

      const nodeData = encodeURIComponent(JSON.stringify({
        title: node.item.title,
        price: node.price,
        owned: node.owned,
        statusClass: node.statusClass,
        description: node.item.description || '',
        isBase: node.isBase
      }));

      return `
        <g class="${classes.join(' ')}" transform="translate(${node.x}, ${node.y})" data-node="${nodeData}" style="cursor: pointer;">
          <rect width="${nodeWidth}" height="${nodeHeight}" rx="16" ry="16" />
          <text x="${nodeWidth / 2}" y="${titleY}" ${titleBaseline} class="siege-route-node-title">${title}</text>
          ${coinLine}
        </g>
      `;
    }).join('');

    return `
      <svg class="siege-route-svg-canvas" viewBox="0 0 ${svgWidth} ${svgHeight}" xmlns="http://www.w3.org/2000/svg">
        <defs>
          <marker id="siege-route-arrow" markerWidth="10" markerHeight="10" refX="8" refY="5" orient="auto" markerUnits="strokeWidth">
            <path d="M0,0 L10,5 L0,10 z" class="siege-route-edge-arrow" />
          </marker>
        </defs>
        <g class="siege-route-edges">${edgePaths}</g>
        <g class="siege-route-nodes">${nodeBlocks}</g>
      </svg>
    `;
  },

  buildComparisonDiagram(graph1, graph2) {
    const sharedNodes = new Set();
    graph1.nodes.forEach(n1 => {
      if (graph2.nodes.some(n2 => n2.key === n1.key)) {
        sharedNodes.add(n1.key);
      }
    });

    const sharedCost = graph1.nodes.filter(n => sharedNodes.has(n.key) && !n.isBase)
      .reduce((sum, n) => sum + n.price, 0);
    const route1OnlyCost = graph1.nodes.filter(n => !sharedNodes.has(n.key) && !n.isBase)
      .reduce((sum, n) => sum + n.price, 0);
    const route2OnlyCost = graph2.nodes.filter(n => !sharedNodes.has(n.key) && !n.isBase)
      .reduce((sum, n) => sum + n.price, 0);

    const totalUnique = route1OnlyCost + route2OnlyCost;
    const totalBoth = sharedCost + totalUnique;

    return `
      <div class="siege-route-comparison-container">
        <div class="siege-comp-summary">
          <h4>Route Comparison</h4>
          <div class="siege-comp-summary-row">
            <span>Shared Prerequisites:</span>
            <strong>${utils.formatCoins(Math.round(sharedCost))}</strong>
          </div>
          <div class="siege-comp-summary-row">
            <span>Unique to Each:</span>
            <strong>${utils.formatCoins(Math.round(totalUnique))}</strong>
          </div>
          <div class="siege-comp-summary-row">
            <span>Total for Both:</span>
            <strong>${utils.formatCoins(Math.round(totalBoth))}</strong>
          </div>
        </div>
        <div class="siege-comp-diagrams">
          <div class="siege-comp-diagram-col">
            <div class="siege-comp-diagram-header route1">${utils.escapeHtml(graph1.targetTitle)}</div>
            ${this.buildSvgDiagram(graph1)}
          </div>
          <div class="siege-comp-diagram-col">
            <div class="siege-comp-diagram-header route2">${utils.escapeHtml(graph2.targetTitle)}</div>
            ${this.buildSvgDiagram(graph2)}
          </div>
        </div>
      </div>
    `;
  },

  buildSummary(graph) {
    if (!graph.nodes.length) {
      return '';
    }

    const totalCoins = Math.round(graph.totalCost);
    const ownedCoins = Math.round(graph.ownedCost);
    const neededCoins = Math.max(0, Math.round(graph.neededCost));
    const title = utils.escapeHtml(graph.targetTitle || 'Upgrade route');
    const totalText = utils.escapeHtml(utils.formatCoins(totalCoins));
    const ownedText = utils.escapeHtml(utils.formatCoins(ownedCoins));
    const neededText = utils.escapeHtml(utils.formatCoins(neededCoins));

    let nextStepHtml = '';
    if (graph.nextStep) {
      const nextTitle = utils.escapeHtml(graph.nextStep.item.title);
      const nextCoins = Math.round(graph.nextStep.price);
      const nextCoinsText = utils.escapeHtml(utils.formatCoins(nextCoins));
      const canAfford = graph.nextStep.statusClass === 'affordable';
      const shortBy = canAfford ? 0 : Math.max(0, nextCoins - utils.getCurrentCoins());
      const shortText = shortBy > 0 ? ` (${utils.escapeHtml(utils.formatCoins(shortBy))} short)` : '';
      const statusIcon = canAfford ? '✓' : '🔒';

      nextStepHtml = `
        <div class="siege-route-next-step">
          <strong>${statusIcon} Next:</strong> ${nextTitle} for ${nextCoinsText}${shortText}
        </div>
      `;
    }

    const comparisonButton = comparisonMode
      ? `<button class="siege-route-compare-btn active" data-route-compare>Exit Comparison</button>`
      : `<button class="siege-route-compare-btn" data-route-compare>Compare Routes</button>`;

    return `
      <div class="siege-route-summary-card">
        <div class="siege-route-summary-title">${title}</div>
        ${nextStepHtml}
        <div class="siege-route-summary-row"><span>Total</span><span>${totalText}</span></div>
        <div class="siege-route-summary-row"><span>Owned</span><span>${ownedText}</span></div>
        <div class="siege-route-summary-row"><span>Remaining</span><span>${neededText}</span></div>
        ${comparisonButton}
      </div>
    `;
  },

  buildTextFallback(graph) {
    if (!graph.nodes.length) {
      return `
        <div class="siege-route-placeholder">
          No prerequisites found for this upgrade.
        </div>
      `;
    }

    const ordered = [...graph.nodes].sort((a, b) => b.depth - a.depth);
    const listItems = ordered.map((node) => {
      const title = utils.escapeHtml(node.item.title);
      const coinsValue = Number.isFinite(node.price) ? Math.round(node.price) : 0;
      const coinsPart = (!node.isBase && coinsValue > 0) ? ` — ${utils.escapeHtml(utils.formatCoins(coinsValue))}` : '';
      return `<li><strong>${title}</strong>${coinsPart}</li>`;
    }).join('');

    return `
      <div class="siege-route-fallback">
        <ul>${listItems}</ul>
      </div>
    `;
  },

  highlightActiveCard() {
    document.querySelectorAll('.siege-item-card.route-active').forEach((card) => {
      card.classList.remove('route-active');
    });

    if (!currentRouteItem || !currentRouteItem.item) {
      return;
    }

    document.querySelectorAll('.siege-item-card').forEach((card) => {
      const datasetValue = card.dataset.item;
      if (!datasetValue) return;

      try {
        const parsed = JSON.parse(decodeURIComponent(datasetValue));
        const sameTitle = parsed.title === currentRouteItem.item.title;
        const sameCategory = !parsed.category || parsed.category === currentRouteItem.category;
        const sameDevice = !parsed.device || parsed.device === currentRouteItem.device;

        if (sameTitle && sameCategory && sameDevice) {
          card.classList.add('route-active');
        }
      } catch (error) {
      }
    });
  },

  async renderCurrentRoute() {
    const container = document.querySelector('[data-route-container]');
    const summaryContainer = document.querySelector('[data-route-summary]');

    this.highlightActiveCard();

    if (!container) {
      return;
    }

    if (!currentRouteItem || !currentRouteItem.item) {
      if (summaryContainer) {
        summaryContainer.innerHTML = '';
      }
      container.innerHTML = `
        <div class="siege-route-placeholder">
          Select an upgrade from the grid to preview its route.
        </div>
      `;
      return;
    }

    const graph = this.buildGraph(currentRouteItem);

    if (summaryContainer) {
      summaryContainer.innerHTML = graph.nodes.length ? this.buildSummary(graph) : '';
    }

    if (!graph.nodes.length) {
      container.innerHTML = `
        <div class="siege-route-placeholder">
          No prerequisites found for this upgrade.
        </div>
      `;
      return;
    }

    if (comparisonMode && comparisonRouteItem) {
      const compGraph = this.buildGraph(comparisonRouteItem);
      container.innerHTML = this.buildComparisonDiagram(graph, compGraph);
    } else {
      container.innerHTML = this.buildSvgDiagram(graph);
    }

    this.attachTooltipListeners();
    this.attachComparisonListeners();
  },

  attachComparisonListeners() {
    const compareBtn = document.querySelector('[data-route-compare]');
    if (!compareBtn) return;

    compareBtn.addEventListener('click', async () => {
      comparisonMode = !comparisonMode;

      if (!comparisonMode) {
        comparisonRouteItem = null;
      }

      await this.renderCurrentRoute();

      if (comparisonMode) {
        components.showToast('Select a second upgrade to compare', 3000);
      }
    });
  },

  attachTooltipListeners() {
    const nodes = document.querySelectorAll('[data-node]');
    const tooltip = document.querySelector('[data-route-tooltip]');

    if (!tooltip) return;

    nodes.forEach(nodeEl => {
      nodeEl.addEventListener('mouseenter', (e) => {
        try {
          const nodeData = JSON.parse(decodeURIComponent(nodeEl.dataset.node));
          this.showTooltip(tooltip, nodeData, e);
        } catch (error) {
          console.error('Error showing tooltip:', error);
        }
      });

      nodeEl.addEventListener('mouseleave', () => {
        tooltip.style.display = 'none';
      });
    });
  },

  showTooltip(tooltip, nodeData, event) {
    if (nodeData.isBase) {
      tooltip.style.display = 'none';
      return;
    }

    const currentCoins = utils.getCurrentCoins();
    const shortBy = Math.max(0, nodeData.price - currentCoins);
    const canAfford = nodeData.statusClass === 'affordable';

    const avgEfficiency = projectStats.getAverageEfficiency();
    const hoursNeeded = shortBy > 0 && avgEfficiency > 0 ? shortBy / avgEfficiency : 0;
    const timeEstimate = hoursNeeded > 0 ? `~${Math.ceil(hoursNeeded * 10) / 10}h at your pace` : '';

    let actionButton = '';
    if (nodeData.owned) {
      actionButton = '<div class="siege-tooltip-owned">✓ Owned</div>';
    } else if (canAfford) {
      actionButton = `<button class="siege-tooltip-buy" onclick="window.location.href='/market'">Buy Now</button>`;
    } else {
      actionButton = `<div class="siege-tooltip-locked">🔒 ${utils.formatCoins(shortBy)} short${timeEstimate ? ` · ${timeEstimate}` : ''}</div>`;
    }

    tooltip.innerHTML = `
      <div class="siege-tooltip-title">${utils.escapeHtml(nodeData.title)}</div>
      <div class="siege-tooltip-price">${utils.formatCoins(nodeData.price)}</div>
      ${nodeData.description ? `<div class="siege-tooltip-desc">${utils.escapeHtml(nodeData.description)}</div>` : ''}
      ${actionButton}
    `;

    tooltip.style.display = 'block';
  }
};

const api = {
  async loadTechTreeData() {
    try {
      return await utils.apiRequest('/market/tech_tree_data');
    } catch (error) {
      return null;
    }
  },

  async loadUserData() {
    try {
      const [coins, purchases] = await Promise.all([
        utils.apiRequest('/market/user_coins'),
        utils.apiRequest('/market/user_purchases')
      ]);

      userCoins = coins.coins || 0;
      userPurchases = purchases.purchases || purchases || [];
      userGoals = goals.getStoredGoals();
      goals.refreshMicroGoals();
      return true;
    } catch (error) {
      return false;
    }
  },

  async purchaseItem(itemName, coinsSpent) {
    try {
      const response = await utils.apiRequest('/market/purchase', {
        method: 'POST',
        body: JSON.stringify({
          item_name: itemName,
          coins_spent: coinsSpent
        })
      });

      if (response.success) {
        await this.loadUserData();
      }

      return response;
    } catch (error) {
      return { success: false, error: error.message };
    }
  }
};

const components = {
  createHeader() {
    return `
      <header class="siege-shop-header">
        <h1 class="siege-shop-title">Market</h1>
        <div class="siege-header-actions">
          <button class="siege-view-orders-btn" id="siege-view-orders-btn">
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
              <path d="M2 3h12M2 8h12M2 13h12" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
            </svg>
            View Orders
          </button>
          <div class="siege-coins-display">${utils.formatCoins(userCoins)}</div>
        </div>
      </header>
    `;
  },

  createCategoryNav() {
    const categories = [
      { id: 'laptop', name: 'Laptop Upgrades' },
      { id: 'tablet', name: 'Tablet Upgrades' },
      { id: 'laptop_grant', name: 'Laptop Grant' },
      { id: 'other', name: 'Other Items' }
    ];

    return `
      <nav class="siege-category-nav">
        ${categories.map(cat => `
          <a href="#" class="siege-category-link ${currentCategory === cat.id ? 'active' : ''}"
             data-category="${cat.id}">
            ${cat.name}
          </a>
        `).join('')}
      </nav>
    `;
  },

  createDeviceSelector(category) {
    if (!techTreeData || !techTreeData[category]) {
      return '';
    }

    const initialNode = techTreeData[category].initialNode;

    if (!initialNode.options) {
      return '';
    }

    const options = initialNode.options;
    const selectedOption = selectedDevice ? options.find(o => o.id === selectedDevice) : null;

    return `
      <div class="siege-device-selector">
        <div class="siege-custom-dropdown" id="deviceSelector">
          <div class="siege-dropdown-selected" data-value="${selectedDevice || ''}">
            ${selectedOption ? selectedOption.title : 'Choose your device...'}
            <svg width="12" height="8" viewBox="0 0 12 8" fill="none" xmlns="http://www.w3.org/2000/svg">
              <path d="M1 1.5L6 6.5L11 1.5" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
            </svg>
          </div>
          <div class="siege-dropdown-options">
            <div class="siege-dropdown-option" data-value="">Choose your device...</div>
            ${options.map(option => `
              <div class="siege-dropdown-option ${selectedDevice === option.id ? 'selected' : ''}" data-value="${option.id}">
                ${option.title}
              </div>
            `).join('')}
          </div>
        </div>
      </div>
    `;
  },

  createItemCard(item) {
    const normalizedPrice = routePlanner.normalizePrice(item.price);
    const purchased = utils.isPurchased(item.title);
    const affordable = utils.canAfford(normalizedPrice);
    const currentCoins = utils.getCurrentCoins();
    const canPlanRoute = Boolean(
      selectedDevice &&
      ['laptop', 'tablet', 'laptop_grant'].includes(currentCategory)
    );
    const showRouteButton = canPlanRoute && Boolean(item.requires);

    let statusClass = 'unaffordable';
    let statusText = 'Cannot afford';

    if (affordable) {
      statusClass = 'affordable';
      statusText = 'Can afford';
    }

    if (purchased) {
      statusText += ' (Owned)';
    }

    const cardClass = `siege-item-card ${!affordable ? 'disabled' : ''}`;

    const estimate = goals.estimateTimeForItem(normalizedPrice, currentCoins);
    const timeEstimate = `
      <div style="font-size: 0.85rem; color: #6b5437; margin-top: 0.5rem; line-height: 1.4;">
        ⏱️ Total time: <strong>${estimate.totalTime}</strong><br>
        ${estimate.neededHours > 0 ? `⏱️ Time needed: <strong>${estimate.timeNeeded}</strong>` : ''}
      </div>
    `;

    const itemPayload = {
      ...item,
      price: normalizedPrice,
      category: currentCategory,
      device: selectedDevice
    };

    return `
      <div class="${cardClass}" data-item="${encodeURIComponent(JSON.stringify(itemPayload))}">
        <div class="siege-item-header">
          ${item.image ? `<div class="siege-item-image"><img src="${item.image}" alt="${item.title}" /></div>` : ''}
          <div class="siege-item-header-text">
            <h3 class="siege-item-title">${item.title}</h3>
            <div class="siege-item-price">${utils.formatCoins(normalizedPrice)}</div>
          </div>
        </div>
        <div class="siege-item-description">${item.description}</div>
        <div class="siege-item-status">
          <span class="siege-status-badge ${statusClass}">${statusText}</span>
          ${item.requires ? `<span class="siege-status-badge">Requires: ${item.requires}</span>` : ''}
        </div>
        ${timeEstimate}
        ${showRouteButton ? '<button class="siege-route-button" data-action="route">View Route</button>' : ''}
        ${goals.createGoalButton({ ...item, price: normalizedPrice })}
      </div>
    `;
  },

  createItemGrid(items) {
    if (!items || items.length === 0) {
      return '<div class="siege-loading">No items available</div>';
    }

    return `
      <div class="siege-items-grid">
        ${items.map(item => this.createItemCard(item)).join('')}
      </div>
    `;
  },

  async createMainInterface() {
    const content = ['laptop', 'tablet', 'laptop_grant'].includes(currentCategory)
      ? this.createUpgradesLayout(currentCategory)
      : await this.createOtherItemsLayout();

    return `
      <div class="siege-shop-container">
        ${this.createHeader()}
        ${goals.createProgressBar()}
        ${this.createCategoryNav()}
        <main class="siege-shop-content">
          ${content}
        </main>
      </div>
    `;
  },

  async createOtherItemsLayout() {
    const shopItems = await shopUtils.getShopItems();

    let items = [];

    if (shopItems && shopItems.other) {
      items = shopItems.other;
    } else {
      console.warn('[Siege Utils] Failed to extract shop items, using fallback');
      items = [
        { id: 1, title: "Mercenary", price: 35, description: "This meeple will fight for you for an hour. Purchase to skip a required hour of sieging!", image: "/assets/meeple/mercenary-63f27597.png", maxPerWeek: 10, priceIncreases: true, oneTime: false },
        { id: 2, title: "Unlock Orange Meeple", price: 50, description: "Not feeling your color? Try orange!", image: "/assets/meeple/meeple-orange-8af8d083.png", oneTime: true },
        { id: 100, title: "Cowboy Hat", price: 50, description: "It's like you're on the farm! (this can be applied to your meeple in the chambers)", image: "/rails/active_storage/blobs/redirect/eyJfcmFpbHMiOnsiZGF0YSI6NDk1LCJwdXIiOiJibG9iX2lkIn19--d7d4d5f434ac8cade9788ac2822fa8ac9176e7f9/cowboyHat.png", oneTime: true, isCosmetic: true },
        { id: 101, title: "Sailor Hat", price: 50, description: "This one's seaworthy (this can be applied to your meeple in the chambers)", image: "/rails/active_storage/blobs/redirect/eyJfcmFpbHMiOnsiZGF0YSI6NDk2LCJwdXIiOiJibG9iX2lkIn19--a6ced8b1d904b059573dd7c1affeba591b1122c5/sailorHat%20(1).png", oneTime: true, isCosmetic: true },
        { id: 102, title: "Satchel", price: 50, description: "Carry your thingies! (this can be applied to your meeple in the chambers)", image: "/rails/active_storage/blobs/redirect/eyJfcmFpbHMiOnsiZGF0YSI6NDk3LCJwdXIiOiJibG9iX2lkIn19--b4fd2e6b51bcc8bedf6407fab207805d9a2354b8/satchel%20(1).png", oneTime: true, isCosmetic: true },
        { id: 200, title: "Controller", price: 200, description: "8Bitdo Ultimate 2C Wireless Controller - A nice controller in lots of pretty colors (you can choose). I have one and it works well :D", image: "/rails/active_storage/blobs/redirect/eyJfcmFpbHMiOnsiZGF0YSI6NDg5LCJwdXIiOiJibG9iX2lkIn19--7226320acc9b55a520763dfe31a18e7ba81092d6/51asxJG4lqL._SL1500_.png", oneTime: false, isPhysicalItem: true, digital: false },
        { id: 201, title: "Apple Trackpad", price: 800, description: "Magic trackpad (USB-C). I hear it works as a scale too!", image: "/rails/active_storage/blobs/redirect/eyJfcmFpbHMiOnsiZGF0YSI6NDkwLCJwdXIiOiJibG9iX2lkIn19--5b10a6106adc20044fe40132be3425abd7f77c0a/MXK93.png", oneTime: false, isPhysicalItem: true, digital: false },
        { id: 202, title: "Cable Card", price: 150, description: "Get a $20 hcb card that can be spent on any cables or dongles! (this can be stacked, just buy multiple!)", image: "/rails/active_storage/blobs/redirect/eyJfcmFpbHMiOnsiZGF0YSI6NDkxLCJwdXIiOiJibG9iX2lkIn19--639bb38d27d0945fe87d74df8003325a9174da67/efd7b802-a673-46e8-9339-a275ab2603ba.77ec191b916ad4a518d82ec585a2ab85.png", oneTime: false, isPhysicalItem: true, digital: true },
        { id: 203, title: "Hollow Knight", price: 100, description: "I hear this game is pretty cool. Lots of bugs. Fulfilled via Steam.", image: "/rails/active_storage/blobs/redirect/eyJfcmFpbHMiOnsiZGF0YSI6NDkyLCJwdXIiOiJibG9iX2lkIn19--4fb090ddd21ea1d979383da58f8674c4434a90e7/hero_capsule.png", oneTime: false, isPhysicalItem: true, digital: true },
        { id: 204, title: "Silksong", price: 120, description: "It's like the last one but more red. Still lots of bugs. Fulfilled via Steam.", image: "/rails/active_storage/blobs/redirect/eyJfcmFpbHMiOnsiZGF0YSI6NDkzLCJwdXIiOiJibG9iX2lkIn19--b4465a46dff1f1ba770fc2b9fc85b44f8df570ef/hero_capsule_2x.png", oneTime: false, isPhysicalItem: true, digital: true },
        { id: 205, title: "Stardew Valley", price: 100, description: "Take a break and farm... delivered via steam!", image: "/rails/active_storage/blobs/redirect/eyJfcmFpbHMiOnsiZGF0YSI6NDk0LCJwdXIiOiJibG9iX2lkIn19--c7cb354b7643a0e59fa7ecb6986ff24b9266ec8e/hero_capsule.png", oneTime: false, isPhysicalItem: true, digital: true }
      ];
    }

    try {
      const response = await utils.apiRequest('/market/mercenary_price');
      if (response && response.price) {
        const mercenaryItem = items.find(item => item.title === "Mercenary");
        if (mercenaryItem) {
          mercenaryItem.price = response.price;
        }
      }
    } catch (error) {
      console.warn('[Siege Utils] Failed to fetch mercenary price:', error);
    }

    return this.createItemGrid(items);
  },

  createUpgradesLayout(category) {
    if (!techTreeData || !techTreeData[category]) {
      return '<div class="siege-loading">Loading upgrades...</div>';
    }

    const layoutClass = isRouteCollapsed ? 'collapsed' : 'expanded';

    return `
      ${this.createDeviceSelector(category)}
      <div class="siege-upgrades-layout ${layoutClass}">
        <div class="siege-upgrades-main">
          ${this.createUpgradeCategories(category)}
        </div>
        ${routePlanner.createSidebar()}
      </div>
    `;
  },

  createUpgradeCategories(category) {
    if (!selectedDevice || !techTreeData[category] || !techTreeData[category].branches[selectedDevice]) {
      return '<div class="siege-loading">Select a device to see upgrade paths</div>';
    }

    const branches = techTreeData[category].branches[selectedDevice];
    const noReqItems = [];
    const hasReqItems = [];

    Object.values(branches).forEach(item => {
      const enriched = routePlanner.enrichItemWithBranchData(item, category, selectedDevice);
      if (enriched.requires) {
        hasReqItems.push(enriched);
      } else {
        noReqItems.push(enriched);
      }
    });

    let upgradesHTML = '';

    if (noReqItems.length > 0) {
      upgradesHTML += `
        <div style="margin-bottom: 2rem;">
          <h3 style="margin-bottom: 1rem; text-align: center; font-size: 1.8rem;">Direct Upgrades</h3>
          <div class="siege-items-grid">
            ${noReqItems.map(item => this.createItemCard(item)).join('')}
          </div>
        </div>
      `;
    }

    if (hasReqItems.length > 0) {
      upgradesHTML += `
        <div>
          <h3 style="margin-bottom: 1rem; text-align: center; font-size: 1.8rem;">Advanced Upgrades</h3>
          <div class="siege-items-grid">
            ${hasReqItems.map(item => this.createItemCard(item)).join('')}
          </div>
        </div>
      `;
    }

    return upgradesHTML;
  },

  showModal(title, message, buttons = []) {
    const modal = document.createElement('div');
    modal.className = 'siege-modal-overlay';
    modal.style.display = 'flex';
    modal.innerHTML = `
      <div class="siege-modal-container">
        <div class="siege-modal-content">
          <h3 class="siege-modal-title">${title}</h3>
          <p class="siege-modal-message">${message}</p>
          <div class="siege-modal-actions">
            ${buttons.map(btn => `<button class="siege-button" data-action="${btn.action}">${btn.text}</button>`).join('')}
          </div>
        </div>
      </div>
    `;
    document.body.appendChild(modal);
    return modal;
  },

  showToast(message) {
    const toast = document.createElement('div');
    toast.className = 'siege-toast';
    toast.textContent = message;
    document.body.appendChild(toast);

    setTimeout(() => {
      toast.remove();
    }, 3000);
  },

  createOrdersModal() {
    const modal = document.createElement('div');
    modal.className = 'siege-modal-overlay';
    modal.id = 'siege-orders-modal';
    modal.style.display = 'flex';

    const totalSpent = userPurchases.reduce((sum, purchase) => {
      const spent = purchase.total_coins_spent || 0;
      return sum + spent;
    }, 0);

    const ordersHTML = userPurchases.length === 0
      ? '<p class="siege-orders-empty">No orders yet. Start shopping to see your purchase history!</p>'
      : userPurchases.map(purchase => {
        const itemPrice = purchase.total_coins_spent || 0;
        const quantity = purchase.quantity || 1;
        const itemName = purchase.item_name || 'Unknown Item';
        const displayName = quantity > 1 ? `${itemName} (x${quantity})` : itemName;

        return `
            <div class="siege-order-item">
              <span class="siege-order-name">${displayName}</span>
              <div class="siege-order-price">${utils.formatCoins(itemPrice)}</div>
            </div>
          `;
      }).join('');

    modal.innerHTML = `
      <div class="siege-modal-container siege-orders-modal-container">
        <div class="siege-modal-content siege-orders-content">
          <div class="siege-orders-header">
            <h3 class="siege-modal-title">Purchase History</h3>
            <button class="siege-orders-close" id="siege-orders-close">✕</button>
          </div>

          <div class="siege-orders-summary">
            <div class="siege-orders-stat">
              <span class="siege-orders-stat-label">Total Orders</span>
              <span class="siege-orders-stat-value">${userPurchases.length}</span>
            </div>
            <div class="siege-orders-stat">
              <span class="siege-orders-stat-label">Total Spent</span>
              <span class="siege-orders-stat-value">${utils.formatCoins(totalSpent)}</span>
            </div>
          </div>

          <div class="siege-orders-list">
            ${ordersHTML}
          </div>
        </div>
      </div>
    `;

    document.body.appendChild(modal);

    const closeBtn = modal.querySelector('#siege-orders-close');
    const overlay = modal;

    closeBtn.addEventListener('click', () => modal.remove());
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) {
        modal.remove();
      }
    });

    return modal;
  }
};

const handlers = {
  async handleCategoryChange(event) {
    event.preventDefault();
    if (!event.target.classList.contains('siege-category-link')) return;

    const category = event.target.dataset.category;
    if (category !== currentCategory) {
      currentCategory = category;
      if (['laptop', 'tablet', 'laptop_grant'].includes(category)) {
        selectedDevice = utils.getDefaultDevice(category) || null;
      } else {
        selectedDevice = null;
      }
      routePlanner.handleContextChange(currentCategory, selectedDevice);
      await render();
    }
  },

  async handleDeviceChange(event) {
    if (event.target.classList.contains('siege-dropdown-option')) {
      const dropdown = event.target.closest('.siege-custom-dropdown');
      const selectedEl = dropdown.querySelector('.siege-dropdown-selected');
      const optionsEl = dropdown.querySelector('.siege-dropdown-options');

      selectedDevice = event.target.dataset.value || null;
      selectedEl.innerHTML = event.target.textContent + `
        <svg width="12" height="8" viewBox="0 0 12 8" fill="none" xmlns="http://www.w3.org/2000/svg">
          <path d="M1 1.5L6 6.5L11 1.5" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
        </svg>
      `;
      selectedEl.dataset.value = selectedDevice;

      optionsEl.classList.remove('show');
      dropdown.classList.remove('open');

      routePlanner.handleContextChange(currentCategory, selectedDevice);
      await render();
    } else if (event.target.classList.contains('siege-dropdown-selected') || event.target.closest('.siege-dropdown-selected')) {
      const dropdown = event.target.closest('.siege-custom-dropdown') || event.target.parentElement.closest('.siege-custom-dropdown');
      if (dropdown) {
        dropdown.classList.toggle('open');
        dropdown.querySelector('.siege-dropdown-options').classList.toggle('show');
      }
    } else if (!event.target.closest('.siege-custom-dropdown')) {
      document.querySelectorAll('.siege-custom-dropdown.open').forEach(dropdown => {
        dropdown.classList.remove('open');
        dropdown.querySelector('.siege-dropdown-options').classList.remove('show');
      });
    }
  },

  async handleItemClick(event) {
    if (event.target.closest('.siege-route-button')) {
      return;
    }

    const card = event.target.closest('.siege-item-card');
    if (!card) return;
    if (card.classList.contains('disabled')) return;

    try {
      const itemData = JSON.parse(decodeURIComponent(card.dataset.item));
      const itemPrice = routePlanner.normalizePrice(itemData.price);
      itemData.price = itemPrice;

      if (!utils.canAfford(itemPrice)) {
        components.showToast('Not enough coins!');
        return;
      }

      const modal = components.showModal(
        'Confirm Purchase',
        `Purchase ${itemData.title} for ${utils.formatCoins(itemPrice)}?`,
        [
          { text: 'Cancel', action: 'cancel' },
          { text: 'Buy', action: 'confirm' }
        ]
      );

      modal.addEventListener('click', async (e) => {
        const action = e.target.dataset.action;
        if (action === 'cancel') {
          modal.remove();
        } else if (action === 'confirm') {
          modal.remove();

          const result = await api.purchaseItem(itemData.title, itemPrice);

          if (result.success) {
            components.showToast(`Successfully purchased ${itemData.title}!`);
            await render();
          } else {
            components.showToast(result.error || 'Purchase failed');
          }
        }
      });

    } catch (error) {
      components.showToast('Purchase failed');
    }
  },

  async handleGoalButtonClick(event) {
    const button = event.target.closest('.siege-goal-button');
    if (!button) return;

    event.preventDefault();
    event.stopPropagation();

    const action = button.dataset.action;
    const goalId = button.dataset.goalId;

    if (action === 'remove' && goalId) {
      goals.removeGoal(parseFloat(goalId));
      components.showToast('Goal removed!');
      await render();
    } else if (action === 'add') {
      const card = button.closest('.siege-item-card');
      if (!card) return;

      try {
        const decodedJson = decodeURIComponent(card.dataset.item);
        const itemData = JSON.parse(decodedJson);
        const success = goals.addGoal(itemData);

        if (success) {
          components.showToast('Goal added!');
          await render();
        } else {
          components.showToast('Goal already exists!');
        }
      } catch (error) {
        components.showToast('Failed to add goal');
      }
    }
  },

  async handleRouteButtonClick(event) {
    const button = event.target.closest('.siege-route-button');
    if (!button) return;

    event.preventDefault();
    event.stopPropagation();

    const card = button.closest('.siege-item-card');
    if (!card) return;

    try {
      const itemData = JSON.parse(decodeURIComponent(card.dataset.item));
      itemData.price = routePlanner.normalizePrice(itemData.price);
      routePlanner.setCurrentRoute({
        item: itemData,
        category: currentCategory,
        device: selectedDevice
      });
      await routePlanner.renderCurrentRoute();
    } catch (error) {
      console.error('[Siege Utils] Failed to prepare route diagram:', error);
      components.showToast('Unable to build route for this upgrade.');
    }
  },

  handleRouteToggle(event) {
    const toggle = event.target.closest('[data-route-toggle]');
    if (!toggle) return;

    event.preventDefault();
    isRouteCollapsed = !isRouteCollapsed;

    const sidebarCard = document.querySelector('.siege-route-card');
    if (sidebarCard) {
      sidebarCard.classList.toggle('collapsed', isRouteCollapsed);
      sidebarCard.classList.toggle('expanded', !isRouteCollapsed);
    }

    toggle.setAttribute('aria-expanded', (!isRouteCollapsed).toString());
    const icon = toggle.querySelector('.siege-route-toggle-icon');
    if (icon) {
      icon.textContent = isRouteCollapsed ? '▸' : '▾';
    }

    const layout = document.querySelector('.siege-upgrades-layout');
    if (layout) {
      layout.classList.toggle('collapsed', isRouteCollapsed);
      layout.classList.toggle('expanded', !isRouteCollapsed);
    }

    routePlanner.renderCurrentRoute();
  },

  handleViewOrdersClick(event) {
    const button = event.target.closest('.siege-view-orders-btn');
    if (!button) return;

    event.preventDefault();
    event.stopPropagation();

    components.createOrdersModal();
  },

  handleProgressTabClick(event) {
    const tab = event.target.closest('.siege-progress-tab');
    if (!tab) return;

    event.preventDefault();
    event.stopPropagation();

    const tabType = tab.dataset.tab;
    const container = tab.closest('.siege-goals-progress');
    if (!container) return;

    const allTabs = container.querySelectorAll('.siege-progress-tab');
    allTabs.forEach(t => {
      t.classList.remove('active');
      t.style.background = 'transparent';
      t.style.color = '#6b7280';
      t.style.borderColor = 'rgba(64, 43, 32, 0.3)';
    });

    tab.classList.add('active');
    tab.style.background = 'rgba(64, 43, 32, 0.2)';
    tab.style.color = '#374151';
    tab.style.borderColor = 'rgba(64, 43, 32, 0.5)';

    const currentContent = container.querySelector('#current-content');
    const projectedContent = container.querySelector('#projected-content');

    if (tabType === 'current') {
      currentContent.style.display = 'block';
      projectedContent.style.display = 'none';
    } else {
      currentContent.style.display = 'none';
      projectedContent.style.display = 'block';
    }
  }
};

async function render() {
  if (!isActive) return;

  const container = document.querySelector('.siege-shop-container');
  if (!container) return;

  const interfaceHTML = await components.createMainInterface();
  container.innerHTML = interfaceHTML;

  routePlanner.ensureDefaultRoute(currentCategory, selectedDevice);

  container.addEventListener('click', handlers.handleCategoryChange);
  container.addEventListener('click', handlers.handleDeviceChange);
  container.addEventListener('click', handlers.handleItemClick);
  container.addEventListener('click', handlers.handleGoalButtonClick);
  container.addEventListener('click', handlers.handleRouteButtonClick);
  container.addEventListener('click', handlers.handleRouteToggle);
  container.addEventListener('click', handlers.handleProgressTabClick);
  container.addEventListener('click', handlers.handleViewOrdersClick);

  await routePlanner.renderCurrentRoute();
}

async function init() {
  if (window.location.pathname.startsWith('/market')) {
    ensureMarketDialogueCleanup();
  }

  if (!window.location.pathname.startsWith('/market') || isActive) {
    return;
  }

  try {
    const originalContainer = document.querySelector('.market-container');
    if (!originalContainer) {
      setTimeout(init, 500);
      return;
    }

    const [loadedTechTreeData, userDataLoaded] = await Promise.all([
      api.loadTechTreeData(),
      api.loadUserData()
    ]);

    if (!loadedTechTreeData || !userDataLoaded) {
      throw new Error('Failed to load required data');
    }

    techTreeData = loadedTechTreeData;
    isActive = true;

    if (currentCategory === 'laptop' || currentCategory === 'tablet' || currentCategory === 'laptop_grant') {
      selectedDevice = utils.getDefaultDevice(currentCategory) || null;
    }

    document.body.classList.add('siege-utils-active');

    const newContainer = document.createElement('div');
    const interfaceHTML = await components.createMainInterface();
    newContainer.innerHTML = interfaceHTML;
    originalContainer.parentNode.insertBefore(newContainer, originalContainer);

    await render();

  } catch (error) {
    components.showToast('Failed to load Siege Utils: ' + error.message);
  }
}

function addProjectControls() {
  if (document.querySelector('.siege-project-controls')) return;

  const projectsActions = document.querySelector('.projects-actions');
  if (!projectsActions) return;

  const sortOptions = [
    { value: 'default', label: 'Default Order' },
    { value: 'week-desc', label: 'Week (Newest First)' },
    { value: 'week-asc', label: 'Week (Oldest First)' },
    { value: 'hours-desc', label: 'Hours (High to Low)' },
    { value: 'hours-asc', label: 'Hours (Low to High)' },
    { value: 'coins-desc', label: 'Coins (High to Low)' },
    { value: 'coins-asc', label: 'Coins (Low to High)' },
    { value: 'efficiency-desc', label: 'Efficiency (High to Low)' },
    { value: 'efficiency-asc', label: 'Efficiency (Low to High)' },
    { value: 'title-asc', label: 'Title (A-Z)' },
    { value: 'title-desc', label: 'Title (Z-A)' }
  ];

  const filterOptions = [
    { value: 'all', label: 'All Projects' },
    { value: 'shipped', label: 'Shipped Only' },
    { value: 'unshipped', label: 'Unshipped Only' },
    { value: 'current-week', label: 'Current Week' },
    { value: 'high-efficiency', label: 'High Efficiency (>2.5)' },
    { value: 'low-efficiency', label: 'Low Efficiency (<2.0)' }
  ];

  const controlsHTML = `
    <div class="siege-project-controls" style="display: flex; gap: 0.75rem; align-items: center; flex-wrap: wrap;">
      <div class="siege-project-dropdown" id="siege-sort-dropdown">
        <div class="siege-project-dropdown-selected" data-value="default">
          <span class="siege-project-dropdown-label">Sort:</span>
          <span class="siege-project-dropdown-value">Default Order</span>
          <svg width="10" height="6" viewBox="0 0 10 6" fill="none" xmlns="http://www.w3.org/2000/svg">
            <path d="M1 1L5 5L9 1" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
          </svg>
        </div>
        <div class="siege-project-dropdown-options">
          ${sortOptions.map(opt => `
            <div class="siege-project-dropdown-option ${opt.value === 'default' ? 'selected' : ''}" data-value="${opt.value}">
              ${opt.label}
            </div>
          `).join('')}
        </div>
      </div>

      <div class="siege-project-dropdown" id="siege-filter-dropdown">
        <div class="siege-project-dropdown-selected" data-value="all">
          <span class="siege-project-dropdown-label">Filter:</span>
          <span class="siege-project-dropdown-value">All Projects</span>
          <svg width="10" height="6" viewBox="0 0 10 6" fill="none" xmlns="http://www.w3.org/2000/svg">
            <path d="M1 1L5 5L9 1" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
          </svg>
        </div>
        <div class="siege-project-dropdown-options">
          ${filterOptions.map(opt => `
            <div class="siege-project-dropdown-option ${opt.value === 'all' ? 'selected' : ''}" data-value="${opt.value}">
              ${opt.label}
            </div>
          `).join('')}
        </div>
      </div>
    </div>
  `;

  projectsActions.insertAdjacentHTML('beforeend', controlsHTML);

  setupProjectDropdown('siege-sort-dropdown', applyProjectSort);
  setupProjectDropdown('siege-filter-dropdown', applyProjectFilter);
}

function setupProjectDropdown(dropdownId, callback) {
  const dropdown = document.getElementById(dropdownId);
  if (!dropdown) return;

  const selected = dropdown.querySelector('.siege-project-dropdown-selected');
  const options = dropdown.querySelector('.siege-project-dropdown-options');
  const valueDisplay = dropdown.querySelector('.siege-project-dropdown-value');

  selected.addEventListener('click', (e) => {
    e.stopPropagation();
    dropdown.classList.toggle('open');
    options.classList.toggle('show');

    document.querySelectorAll('.siege-project-dropdown').forEach(dd => {
      if (dd !== dropdown) {
        dd.classList.remove('open');
        dd.querySelector('.siege-project-dropdown-options').classList.remove('show');
      }
    });
  });

  dropdown.querySelectorAll('.siege-project-dropdown-option').forEach(option => {
    option.addEventListener('click', (e) => {
      e.stopPropagation();

      const value = option.dataset.value;
      const label = option.textContent.trim();

      dropdown.querySelectorAll('.siege-project-dropdown-option').forEach(opt => {
        opt.classList.remove('selected');
      });
      option.classList.add('selected');

      selected.dataset.value = value;
      valueDisplay.textContent = label;

      dropdown.classList.remove('open');
      options.classList.remove('show');

      callback({ target: { value, label } });
    });
  });

  document.addEventListener('click', (e) => {
    if (!dropdown.contains(e.target)) {
      dropdown.classList.remove('open');
      options.classList.remove('show');
    }
  });
}

function applyProjectSort(e) {
  const sortValue = e.target.value;
  const projectCards = Array.from(document.querySelectorAll('article.project-card[id^="project_"]'));
  const container = projectCards[0]?.parentElement;
  if (!container) return;

  projectCards.sort((a, b) => {
    const aData = extractCardData(a);
    const bData = extractCardData(b);

    let comparison;

    switch (sortValue) {
      case 'default':
        comparison = aData.originalIndex - bData.originalIndex;
        break;
      case 'week-desc':
        comparison = bData.week - aData.week;
        break;
      case 'week-asc':
        comparison = aData.week - bData.week;
        break;
      case 'hours-desc':
        comparison = bData.hours - aData.hours;
        break;
      case 'hours-asc':
        comparison = aData.hours - bData.hours;
        break;
      case 'coins-desc':
        comparison = bData.coins - aData.coins;
        break;
      case 'coins-asc':
        comparison = aData.coins - bData.coins;
        break;
      case 'efficiency-desc':
        comparison = bData.efficiency - aData.efficiency;
        break;
      case 'efficiency-asc':
        comparison = aData.efficiency - bData.efficiency;
        break;
      case 'title-asc':
        comparison = aData.title.localeCompare(bData.title);
        break;
      case 'title-desc':
        comparison = bData.title.localeCompare(aData.title);
        break;
      default:
        comparison = 0;
        break;
    }

    if (comparison === 0) {
      comparison = aData.originalIndex - bData.originalIndex;
    }

    return comparison;
  });

  projectCards.forEach(card => container.appendChild(card));
}

function applyProjectFilter(e) {
  const filterValue = e.target.value;
  const projectCards = document.querySelectorAll('article.project-card[id^="project_"]');
  const currentWeek = utils.getCurrentWeek();

  projectCards.forEach(card => {
    const data = extractCardData(card);
    let shouldShow = false;

    switch (filterValue) {
      case 'all':
        shouldShow = true;
        break;
      case 'shipped':
        shouldShow = data.shipped;
        break;
      case 'unshipped':
        shouldShow = !data.shipped;
        break;
      case 'current-week':
        shouldShow = data.week === currentWeek;
        break;
      case 'high-efficiency':
        shouldShow = data.efficiency > 2.5;
        break;
      case 'low-efficiency':
        shouldShow = data.efficiency < 2.0;
        break;
      default:
        shouldShow = true;
    }

    card.style.display = shouldShow ? '' : 'none';
  });
}

function extractCardData(card) {
  const dataset = card.dataset || {};

  let hours = parseFloat(dataset.siegeHours);
  let coins = parseFloat(dataset.siegeCoins);
  let efficiency = parseFloat(dataset.siegeEfficiency);
  let shipped;
  const originalIndexRaw = parseInt(dataset.siegeOriginalIndex ?? '-1', 10);
  let originalIndex = Number.isNaN(originalIndexRaw) ? -1 : originalIndexRaw;

  if (typeof dataset.siegeShipped === 'string') {
    shipped = dataset.siegeShipped === 'true';
  }

  const datasetHasValues = !Number.isNaN(hours) && !Number.isNaN(coins) && !Number.isNaN(efficiency);

  if (!datasetHasValues || typeof shipped === 'undefined') {
    const statusElement = card.querySelector('.project-status-indicator');
    const statusText = statusElement ? statusElement.textContent.trim() : '';
    const fallbackShipped = statusText.includes('🪙') ||
      /\d+\.\d+/.test(statusText) ||
      statusText.toLowerCase().includes('submitted for review') ||
      statusText.toLowerCase().includes('under review');

    const efficiencyBox = card.querySelector('.siege-efficiency-box');
    let fallbackHours = 0;
    let fallbackCoins = 0;
    let fallbackEfficiency = 0;

    if (efficiencyBox) {
      const hoursMatch = efficiencyBox.textContent.match(/(\d+\.?\d*)h/);
      const coinsMatch = statusText.match(/(\d+\.?\d*)/);
      fallbackHours = hoursMatch ? parseFloat(hoursMatch[1]) : 0;
      fallbackCoins = coinsMatch ? parseFloat(coinsMatch[1]) : 0;
      fallbackEfficiency = fallbackHours > 0 ? fallbackCoins / fallbackHours : 0;
    }

    if (Number.isNaN(hours)) hours = fallbackHours;
    if (Number.isNaN(coins)) coins = fallbackCoins;
    if (Number.isNaN(efficiency)) efficiency = fallbackEfficiency;
    if (typeof shipped === 'undefined') shipped = fallbackShipped;
  }

  let week = 0;
  const weekBadge = card.querySelector('.project-badge');
  if (weekBadge) {
    const weekMatch = weekBadge.textContent.match(/Week (\d+)/);
    if (weekMatch) {
      week = parseInt(weekMatch[1], 10);
    }
  }

  let title = '';
  const titleElement = card.querySelector('.project-title');
  if (titleElement) {
    title = titleElement.textContent.trim();
  }

  return {
    hours: Number.isFinite(hours) ? hours : 0,
    coins: Number.isFinite(coins) ? coins : 0,
    efficiency: Number.isFinite(efficiency) ? efficiency : 0,
    shipped: Boolean(shipped),
    originalIndex: originalIndex >= 0 ? originalIndex : Number.MAX_SAFE_INTEGER,
    week: week || 0,
    title: title || ''
  };
}

async function enhanceProjectCards() {
  const projectCards = Array.from(document.querySelectorAll('article.project-card[id^="project_"]'));

  const allProjectLinks = document.querySelectorAll('a[href*="/projects/"]');
  allProjectLinks.forEach(link => {
    link.href = link.href.replace('/projects/', '/armory/');
  });

  for (const [index, card] of projectCards.entries()) {
    if (typeof card.dataset.siegeOriginalIndex === 'undefined') {
      card.dataset.siegeOriginalIndex = index.toString();
    }

    if (card.querySelector('.siege-efficiency-box')) continue;

    try {
      const projectData = await projectStats.extractProjectData(card);

      if (projectData) {
        const statusElement = card.querySelector('.project-status-indicator');
        const statusText = statusElement ? statusElement.textContent : 'NO STATUS ELEMENT';
        const hasCoins = statusText.includes('🪙') ||
          /Value:\s*\d+(\.\d+)?/.test(statusText) ||
          /\d+\.\d+\s*🪙/.test(statusText) ||
          statusText.includes('coin') ||
          /\d+\s*coins?/i.test(statusText);

        const isUnshipped = !hasCoins;

        const normalizedHours = Number.isFinite(projectData.hours) ? projectData.hours : 0;
        const normalizedCoins = Number.isFinite(projectData.totalCoins) ? projectData.totalCoins : 0;
        const normalizedEfficiency = normalizedHours > 0 && normalizedCoins > 0
          ? normalizedCoins / normalizedHours
          : (Number.isFinite(projectData.coinsPerHour) ? projectData.coinsPerHour : 0);

        card.dataset.siegeHours = normalizedHours.toString();
        card.dataset.siegeCoins = normalizedCoins.toString();
        card.dataset.siegeEfficiency = normalizedEfficiency.toString();
        card.dataset.siegeShipped = (!isUnshipped).toString();

        const reviewerFeedback = card.querySelector('.reviewer-feedback-indicator');
        const projectFooter = card.querySelector('.project-footer');
        const targetElement = reviewerFeedback || projectFooter;

        if (targetElement) {
          const badge = projectStats.createEfficiencyBadge(projectData);
          targetElement.insertAdjacentHTML('afterend', badge);
        }
      }
    } catch (error) {
      console.error('Failed to enhance project card:', error);
    }
  }

  addProjectControls();
}

async function enhanceProjectPage() {
  const urlMatch = window.location.pathname.match(/\/armory\/(\d+)/);
  if (!urlMatch) {
    return;
  }

  const projectId = urlMatch[1];

  if (document.querySelector('.siege-project-stats-content')) {
    return;
  }

  const stats = projectStats.getStoredStats();
  const storedData = stats[`project_${projectId}`];

  if (storedData) {

    const projectData = {
      projectId,
      week: storedData.week,
      hours: storedData.hours,
      totalCoins: storedData.total_coins,
      avgScore: storedData.avg_score,
      reviewerBonus: storedData.reviewer_bonus,
      coinsPerHour: storedData.coins_per_hour
    };

    const detailedStats = projectStats.createDetailedStats(projectData);

    const reviewerFeedback = document.querySelector('.reviewer-feedback-container');
    if (reviewerFeedback) {
      reviewerFeedback.insertAdjacentHTML('beforebegin', detailedStats);
    } else {
      const projectDetails = document.querySelector('.project-details');
      if (projectDetails) {
        projectDetails.insertAdjacentHTML('beforeend', detailedStats);
      }
    }
    return;
  }


  try {
    const timeElement = document.querySelector('.project-week-time');
    const valueElement = document.querySelector('.project-status-display');
    const titleElement = document.querySelector('.projects-title');
    const avgScoreElement = document.querySelector('.submit-button.submit-button--disabled') ||
      document.querySelector('.project-score');

    if (!timeElement || !titleElement) {
      return;
    }

    const timeStr = timeElement.textContent.replace('Time spent: ', '');
    const fallbackHours = projectStats.parseTimeString(timeStr);

    const valueStr = valueElement ? valueElement.textContent : '';
    const totalCoins = valueElement ? projectStats.parseCoins(valueStr) : 0;

    const titleStr = titleElement.textContent;
    const week = projectStats.parseWeek(titleStr);

    let avgScore = null;
    if (avgScoreElement) {
      const avgScoreMatch = avgScoreElement.textContent.match(/Avg\.\s*Score:\s*([\d.]+)/);
      avgScore = avgScoreMatch ? parseFloat(avgScoreMatch[1]) : null;
    }

    const isUnshipped = totalCoins === 0;
    const resolvedHours = await projectStats.resolveProjectHours(projectId, {
      fallbackHours,
      projectWeek: week,
      track: isUnshipped
    });

    if (!resolvedHours && resolvedHours !== 0) {
      return;
    }

    const currentWeek = utils.getCurrentWeek();
    const isCurrentWeek = week === currentWeek;

    const estimates = projectStats.estimateReviewerAndVoterStats(totalCoins, week, resolvedHours);
    const coinsPerHour = projectStats.calculateEfficiency(totalCoins, resolvedHours);

    const projectData = {
      projectId,
      week,
      hours: resolvedHours,
      totalCoins,
      avgScore: avgScore || estimates.avgVoterStars,
      reviewerBonus: estimates.reviewerBonus,
      coinsPerHour
    };

    let stats = projectStats.getStoredStats();
    stats[`project_${projectId}`] = {
      avg_score: avgScore || estimates.avgVoterStars,
      reviewer_bonus: estimates.reviewerBonus,
      week: week,
      hours: resolvedHours,
      total_coins: totalCoins,
      coins_per_hour: coinsPerHour
    };
    projectStats.saveStats(stats);

    const detailedStats = projectStats.createDetailedStats(projectData);

    let projectionsHTML = '';
    if (isCurrentWeek && isUnshipped) {
      const unshippedHours = projectStats.getUnshippedTime(projectId);
      const hoursToProject = unshippedHours > 0 ? unshippedHours : resolvedHours;
      projectionsHTML = projectStats.createProjectProjections(projectId, hoursToProject, week);
    }

    const reviewerFeedback = document.querySelector('.reviewer-feedback-indicator') ||
      document.querySelector('[class*="reviewer"]') ||
      document.querySelector('[class*="feedback"]');

    let insertionPoint;
    if (reviewerFeedback) {
      insertionPoint = reviewerFeedback;
      insertionPoint.insertAdjacentHTML('beforebegin', detailedStats + projectionsHTML);
    } else {
      const statusDisplay = document.querySelector('.project-status-display');
      const timeDisplay = document.querySelector('.project-week-time');

      if (statusDisplay) {
        const container = statusDisplay.closest('.project-header') || statusDisplay.parentElement;
        if (container && container.classList.contains('project-header')) {
          container.insertAdjacentHTML('afterend', detailedStats + projectionsHTML);
        } else {
          statusDisplay.insertAdjacentHTML('afterend', detailedStats + projectionsHTML);
        }
      } else if (timeDisplay) {
        timeDisplay.insertAdjacentHTML('afterend', detailedStats + projectionsHTML);
      } else {
        insertionPoint = document.querySelector('.project-details') ||
          document.querySelector('.project-content') ||
          document.querySelector('.project-info') ||
          document.querySelector('main') ||
          document.querySelector('[class*="project"]') ||
          document.querySelector('[class*="content"]');

        if (insertionPoint) {
          insertionPoint.insertAdjacentHTML('beforeend', detailedStats + projectionsHTML);
        } else {
          document.body.insertAdjacentHTML('beforeend', detailedStats + projectionsHTML);
        }
      }
    }

  } catch (error) {
    console.error('Failed to enhance project page:', error);
  }
}

function calculateVisualTextLength(text) {
  return text.replace(/\s+/g, ' ').trim().length;
}

function addExploreFilters() {
  if (document.querySelector('.siege-explore-filters')) return;

  const mainContent = document.querySelector('main') || document.querySelector('.projects-explore');
  if (!mainContent) return;

  const filtersHTML = `
    <div class="siege-explore-filters" style="margin-bottom: 2rem; padding-top: 1.5rem;">
      <!-- Single Row: Search on left, Filters on right -->
      <div style="
        display: grid;
        grid-template-columns: 1fr auto auto auto auto;
        gap: 0.75rem;
        align-items: center;
      ">
        <!-- Search Bar -->
        <input
          type="text"
          id="siege-search-input"
          placeholder="🔍 Search projects..."
          style="
            padding: 0.6rem 1rem;
            border: 2px solid rgba(64, 43, 32, 0.2);
            border-radius: 6px;
            font-size: 0.9rem;
            background: white;
            transition: all 0.2s;
            font-family: inherit;
            box-shadow: 0 1px 3px rgba(0, 0, 0, 0.05);
          "
          onfocus="this.style.borderColor='rgba(146, 64, 14, 0.4)'; this.style.boxShadow='0 0 0 3px rgba(146, 64, 14, 0.08), 0 1px 3px rgba(0, 0, 0, 0.05)'"
          onblur="this.style.borderColor='rgba(64, 43, 32, 0.2)'; this.style.boxShadow='0 1px 3px rgba(0, 0, 0, 0.05)'"
        />

        <!-- Results Counter -->
        <div id="siege-filter-count" style="
          font-size: 0.875rem;
          color: rgba(59, 42, 26, 0.7);
          font-weight: 600;
          white-space: nowrap;
        "></div>

        <!-- Status Filter -->
        <div class="siege-project-dropdown" id="siege-explore-status-dropdown">
          <div class="siege-project-dropdown-selected" data-value="all">
            <span class="siege-project-dropdown-value">All Status</span>
            <svg width="10" height="6" viewBox="0 0 10 6" fill="none" xmlns="http://www.w3.org/2000/svg">
              <path d="M1 1L5 5L9 1" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
            </svg>
          </div>
          <div class="siege-project-dropdown-options">
            <div class="siege-project-dropdown-option selected" data-value="all">All Status</div>
            <div class="siege-project-dropdown-option" data-value="shipped">✓ Shipped</div>
            <div class="siege-project-dropdown-option" data-value="unshipped">○ Unshipped</div>
          </div>
        </div>

        <!-- Week Filter -->
        <div class="siege-project-dropdown" id="siege-explore-week-dropdown">
          <div class="siege-project-dropdown-selected" data-value="all">
            <span class="siege-project-dropdown-value">All Weeks</span>
            <svg width="10" height="6" viewBox="0 0 10 6" fill="none" xmlns="http://www.w3.org/2000/svg">
              <path d="M1 1L5 5L9 1" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
            </svg>
          </div>
          <div class="siege-project-dropdown-options">
            <div class="siege-project-dropdown-option selected" data-value="all">All Weeks</div>
          </div>
        </div>

        <!-- Reset Button -->
        <button id="siege-reset-filters" style="
          padding: 0.6rem 1.1rem;
          background: rgba(146, 64, 14, 0.08);
          border: 2px solid rgba(146, 64, 14, 0.25);
          border-radius: 6px;
          font-size: 0.8rem;
          font-weight: 700;
          color: rgba(92, 40, 7, 0.9);
          cursor: pointer;
          transition: all 0.2s;
          text-transform: uppercase;
          letter-spacing: 0.3px;
          white-space: nowrap;
          font-family: inherit;
        "
        onmouseover="this.style.background='rgba(146, 64, 14, 0.15)'; this.style.borderColor='rgba(146, 64, 14, 0.35)'"
        onmouseout="this.style.background='rgba(146, 64, 14, 0.08)'; this.style.borderColor='rgba(146, 64, 14, 0.25)'"
        onmousedown="this.style.transform='scale(0.98)'"
        onmouseup="this.style.transform='scale(1)'">
          Reset
        </button>
      </div>
    </div>
  `;

  const projectsHeader = document.querySelector('.projects-header');
  if (projectsHeader) {
    projectsHeader.insertAdjacentHTML('afterend', filtersHTML);
  } else {
    const pageTitle = document.querySelector('h1') || document.querySelector('.page-title') || mainContent.querySelector('h1, h2');
    if (pageTitle) {
      pageTitle.insertAdjacentHTML('afterend', filtersHTML);
    } else {
      mainContent.insertAdjacentHTML('afterbegin', filtersHTML);
    }
  }

  const projectCards = document.querySelectorAll('.project-card');
  const weeks = new Set();
  projectCards.forEach(card => {
    const badge = card.querySelector('.project-badge');
    if (badge) {
      const weekMatch = badge.textContent.match(/Week (\d+)/);
      if (weekMatch) {
        weeks.add(parseInt(weekMatch[1]));
      }
    }
  });

  const weekDropdownOptions = document.querySelector('#siege-explore-week-dropdown .siege-project-dropdown-options');
  Array.from(weeks).sort((a, b) => b - a).forEach(week => {
    const option = document.createElement('div');
    option.className = 'siege-project-dropdown-option';
    option.dataset.value = week;
    option.textContent = `Week ${week}`;
    weekDropdownOptions.appendChild(option);
  });

  setupProjectDropdown('siege-explore-status-dropdown', ({ target }) => {
    applyFilters();
  });
  setupProjectDropdown('siege-explore-week-dropdown', ({ target }) => {
    applyFilters();
  });

  function applyFilters() {
    const searchTerm = document.getElementById('siege-search-input').value.toLowerCase();
    const statusDropdown = document.querySelector('#siege-explore-status-dropdown .siege-project-dropdown-selected');
    const weekDropdown = document.querySelector('#siege-explore-week-dropdown .siege-project-dropdown-selected');
    const statusFilter = statusDropdown?.dataset.value || 'all';
    const weekFilter = weekDropdown?.dataset.value || 'all';

    let visibleCount = 0;

    projectCards.forEach(card => {
      let show = true;

      if (searchTerm) {
        const title = card.querySelector('.project-title')?.textContent.toLowerCase() || '';
        const description = card.querySelector('.project-description')?.textContent.toLowerCase() || '';
        const fullText = title + ' ' + description;

        if (!fullText.includes(searchTerm)) {
          show = false;
        }
      }

      if (statusFilter !== 'all') {
        const statusIndicator = card.querySelector('.project-status-indicator');
        const hasCoins = statusIndicator && (
          statusIndicator.textContent.includes('🪙') ||
          /Value:\s*\d+/.test(statusIndicator.textContent) ||
          /\d+\s*coins?/i.test(statusIndicator.textContent)
        );

        if (statusFilter === 'shipped' && !hasCoins) {
          show = false;
        } else if (statusFilter === 'unshipped' && hasCoins) {
          show = false;
        }
      }

      if (weekFilter !== 'all') {
        const badge = card.querySelector('.project-badge');
        const weekMatch = badge?.textContent.match(/Week (\d+)/);
        const cardWeek = weekMatch ? weekMatch[1] : null;

        if (cardWeek !== weekFilter) {
          show = false;
        }
      }

      card.style.display = show ? '' : 'none';
      if (show) visibleCount++;
    });

    const countEl = document.getElementById('siege-filter-count');
    if (countEl) {
      countEl.textContent = `Showing ${visibleCount} of ${projectCards.length} projects`;
    }

    setTimeout(() => {
      const visibleCards = Array.from(projectCards).filter(card => card.style.display !== 'none');
      const rows = {};

      visibleCards.forEach((card, index) => {
        const rowIndex = Math.floor(index / 3);
        if (!rows[rowIndex]) rows[rowIndex] = [];
        rows[rowIndex].push(card);
      });

      Object.values(rows).forEach(rowCards => {
        rowCards.forEach(card => card.style.height = 'auto');
        const heights = rowCards.map(card => card.offsetHeight);
        const maxHeight = Math.max(...heights);
        rowCards.forEach(card => card.style.height = `${maxHeight}px`);
      });
    }, 50);
  }

  document.getElementById('siege-search-input').addEventListener('input', applyFilters);

  document.getElementById('siege-reset-filters').addEventListener('click', () => {
    document.getElementById('siege-search-input').value = '';

    const statusDropdown = document.getElementById('siege-explore-status-dropdown');
    const statusSelected = statusDropdown.querySelector('.siege-project-dropdown-selected');
    const statusValue = statusDropdown.querySelector('.siege-project-dropdown-value');
    statusSelected.dataset.value = 'all';
    statusValue.textContent = 'All Status';
    statusDropdown.querySelectorAll('.siege-project-dropdown-option').forEach(opt => {
      opt.classList.toggle('selected', opt.dataset.value === 'all');
    });

    const weekDropdown = document.getElementById('siege-explore-week-dropdown');
    const weekSelected = weekDropdown.querySelector('.siege-project-dropdown-selected');
    const weekValue = weekDropdown.querySelector('.siege-project-dropdown-value');
    weekSelected.dataset.value = 'all';
    weekValue.textContent = 'All Weeks';
    weekDropdown.querySelectorAll('.siege-project-dropdown-option').forEach(opt => {
      opt.classList.toggle('selected', opt.dataset.value === 'all');
    });

    applyFilters();
  });

  applyFilters();
}

function enhanceArmoryExplore() {
  if (window.location.pathname !== '/armory/explore') return;

  addExploreFilters();

  const projectCards = Array.from(document.querySelectorAll('.project-card'));

  const cardsPerRow = 3;
  const cardData = [];

  projectCards.forEach((card, index) => {
    const descriptionMarker = card.querySelector('.project-description');
    if (!descriptionMarker) return;

    const projectLinks = card.querySelector('.project-links');
    let fullHTML = '';
    let currentElement = descriptionMarker.nextElementSibling;

    while (currentElement && currentElement !== projectLinks) {
      fullHTML += currentElement.outerHTML;
      currentElement = currentElement.nextElementSibling;
    }

    const tempDiv = document.createElement('div');
    tempDiv.innerHTML = fullHTML;
    const textContent = (tempDiv.textContent || tempDiv.innerText || '').trim();
    const visualLength = calculateVisualTextLength(textContent);
    const hasHeadings = /<h[1-6]/i.test(fullHTML);

    cardData.push({
      card,
      index,
      descriptionMarker,
      projectLinks,
      fullHTML,
      textContent,
      visualLength,
      hasHeadings,
      rowIndex: Math.floor(index / cardsPerRow)
    });
  });

  const rowLimits = {};
  cardData.forEach(data => {
    if (!rowLimits[data.rowIndex]) {
      rowLimits[data.rowIndex] = [];
    }
    rowLimits[data.rowIndex].push(data.visualLength);
  });

  Object.keys(rowLimits).forEach(rowIndex => {
    const lengths = rowLimits[rowIndex];
    const avgLength = lengths.reduce((sum, len) => sum + len, 0) / lengths.length;
    rowLimits[rowIndex] = Math.max(100, Math.floor(avgLength * 0.25));
  });

  cardData.forEach((data) => {
    if (data.descriptionMarker.dataset.siegeEnhanced) {
      return;
    }

    data.descriptionMarker.dataset.siegeEnhanced = 'true';

    if (data.visualLength === 0) {
      return;
    }

    const charLimit = rowLimits[data.rowIndex];

    if (data.visualLength > charLimit) {
      const normalizedText = data.textContent.replace(/\s+/g, ' ').trim();
      const shortText = normalizedText.substring(0, charLimit).trim();

      let currentElement = data.descriptionMarker.nextElementSibling;
      while (currentElement && currentElement !== data.projectLinks) {
        const toRemove = currentElement;
        currentElement = currentElement.nextElementSibling;
        toRemove.remove();
      }

      const wrapper = document.createElement('div');
      wrapper.className = 'siege-description-wrapper';
      wrapper.innerHTML = `
        <div class="siege-description-short">${shortText}...</div>
        <div class="siege-description-full" style="display: none;">${data.fullHTML}</div>
        <button class="siege-read-more" style="
          background: none;
          border: none;
          color: rgba(59, 42, 26, 0.7);
          font-size: 0.75rem;
          font-weight: 600;
          cursor: pointer;
          padding: 0.25rem 0;
          margin-top: 0.25rem;
          text-decoration: underline;
          position: relative;
          z-index: 3;
        ">Read more</button>
      `;

      data.descriptionMarker.parentNode.insertBefore(wrapper, data.projectLinks);

      const readMoreBtn = wrapper.querySelector('.siege-read-more');
      const shortDiv = wrapper.querySelector('.siege-description-short');
      const fullDiv = wrapper.querySelector('.siege-description-full');

      if (readMoreBtn) {
        readMoreBtn.addEventListener('click', (e) => {
          e.preventDefault();
          e.stopPropagation();

          if (fullDiv.style.display === 'none') {
            shortDiv.style.display = 'none';
            fullDiv.style.display = 'block';
            readMoreBtn.textContent = 'Read less';
          } else {
            shortDiv.style.display = 'block';
            fullDiv.style.display = 'none';
            readMoreBtn.textContent = 'Read more';
          }
        });
      }
    }
  });

  setTimeout(() => {
    const rows = {};
    cardData.forEach(data => {
      if (!rows[data.rowIndex]) {
        rows[data.rowIndex] = [];
      }
      rows[data.rowIndex].push(data.card);
    });

    Object.values(rows).forEach(rowCards => {
      rowCards.forEach(card => {
        card.style.height = 'auto';
      });

      const heights = rowCards.map(card => card.offsetHeight);
      const maxHeight = Math.max(...heights);

      rowCards.forEach(card => {
        card.style.height = `${maxHeight}px`;
      });
    });
  }, 100);
}

async function initProjectStats() {
  if (window.location.pathname === '/armory') {
    await enhanceProjectCards();
    goals.refreshMicroGoals();
  } else if (window.location.pathname === '/armory/explore') {
    enhanceArmoryExplore();
    goals.refreshMicroGoals();
  } else if (window.location.pathname.match(/\/armory\/\d+/)) {
    let retries = 0;
    const maxRetries = 5;

    while (retries < maxRetries) {
      try {
        await enhanceProjectPage();
        goals.refreshMicroGoals();
        break;
      } catch (error) {
        retries++;
        if (retries < maxRetries) {
          await new Promise(resolve => setTimeout(resolve, 1000));
        }
      }
    }
  }
}

if (typeof window !== 'undefined') {
  let lastPath = window.location.pathname;
  let navigationTimeout = null;
  const MARKET_DIALOGUE_STYLE_ID = 'siege-utils-market-dialogue-hide';

  async function initKeepEnhancements() {
    if (window.location.pathname !== '/keep') {
      return;
    }

    try {
      await enhanceKeepPage();
    } catch (error) {
      console.error('Error enhancing keep page:', error);
    }
  }

  let footerObserver = null;

  async function enhanceKeepPage() {
    const homeContainer = document.querySelector('.home-container');
    if (!homeContainer) {
      setTimeout(() => enhanceKeepPage(), 500);
      return;
    }

    if (homeContainer.dataset.siegeEnhanced === 'true') {
      return;
    }


    const coffersTitle = utils.findCoffersTitle();
    let currentCoins = 0;
    let hasCoinValue = false;
    if (coffersTitle) {
      const coinMatch = coffersTitle.textContent.match(/Your coffers: (\d+)/);
      if (coinMatch) {
        const parsedCoins = parseInt(coinMatch[1], 10);
        if (!Number.isNaN(parsedCoins)) {
          currentCoins = parsedCoins;
          hasCoinValue = true;
        }
      }
    }

    if (hasCoinValue) {
      userCoins = currentCoins;
    }

    const projectionData = goals.getProjectionData();
    enhanceCoffersDisplay(projectionData);
    addTotalPillagingStats(currentCoins);
    addWeeklyBreakdownChart();
    goals.refreshMicroGoals();
    addWeeklyHoursPlanner();
    initCountdownTimer();
    setupFooterObserver();
    homeContainer.dataset.siegeEnhanced = 'true';

  }

  function setupFooterObserver() {
    if (footerObserver) {
      footerObserver.disconnect();
    }

    const footer = document.querySelector('.home-progress-footer');
    if (!footer) return;

    footerObserver = new MutationObserver(() => {
      if (!document.getElementById('time-till-next-week-container')) {
        initCountdownTimer();
      }
      if (!document.querySelector('[data-siege-hours-planner]')) {
        addWeeklyHoursPlanner();
      }
    });

    footerObserver.observe(footer, {
      childList: true,
      subtree: true
    });
  }

  function enhanceCoffersDisplay(projectionData) {
    const coffersTitle = utils.findCoffersTitle();
    if (!coffersTitle) {
      return;
    }

    if (coffersTitle.querySelector('[data-siege-projected]')) {
      return;
    }

    const coinMatch = coffersTitle.textContent.match(/Your coffers: (\d+)/);
    if (!coinMatch) return;

    const currentCoins = parseInt(coinMatch[1]);
    const projectedCoins = projectionData.projectedFromUnshipped || 0;

    animateCoinsCountUp(coffersTitle, currentCoins);

    if (projectedCoins > 0) {
      const coinIcon = coffersTitle.querySelector('.coin-icon');
      if (coinIcon) {
        coinIcon.insertAdjacentHTML('afterend', `
          <span data-siege-projected="true" style="font-size: 0.55em;"> (+${projectedCoins}🪙 projected)</span>
        `);
      }
    }
  }

  function animateCoinsCountUp(titleElement, targetValue, duration = 2000) {
    const coinMatch = titleElement.textContent.match(/(.*: )(\d+)(.*)/);
    if (!coinMatch) return;

    const [, prefix, currentNum, suffix] = coinMatch;
    const startValue = 0;
    const startTime = Date.now();

    function easeOutQuint(t) {
      return 1 - Math.pow(1 - t, 5);
    }

    function updateValue() {
      const elapsed = Date.now() - startTime;
      const progress = Math.min(elapsed / duration, 1);

      const easedProgress = easeOutQuint(progress);
      const currentValue = Math.round(startValue + (targetValue - startValue) * easedProgress);

      titleElement.childNodes.forEach(node => {
        if (node.nodeType === Node.TEXT_NODE && node.textContent.includes(':')) {
          node.textContent = `${prefix}${currentValue}${suffix.replace(/🪙.*/, '')}`;
        }
      });

      if (progress < 1) {
        requestAnimationFrame(updateValue);
      }
    }

    setTimeout(() => {
      requestAnimationFrame(updateValue);
    }, 100);
  }

  function addTotalPillagingStats(currentCoins = 0) {
    const twoColDiv = document.querySelector('.home-two-col');
    if (!twoColDiv) return;

    if (document.querySelector('[data-siege-stats]')) {
      return;
    }

    const shippedStats = projectStats.getStoredStats();
    const timeTracking = projectStats.getStoredTimeTracking();

    let totalShippedHours = 0;
    let totalShippedCoins = 0;
    let shippedProjects = 0;
    let weekStats = {};

    Object.values(shippedStats).forEach(project => {
      totalShippedHours += project.hours;
      totalShippedCoins += project.total_coins;
      shippedProjects++;

      if (!weekStats[project.week]) {
        weekStats[project.week] = { hours: 0, projects: new Set() };
      }
      weekStats[project.week].hours += project.hours;
      weekStats[project.week].projects.add(`shipped_${project.week}`);
    });

    let totalUnshippedHours = 0;
    let unshippedProjects = 0;

    Object.keys(timeTracking).forEach(projectId => {
      const tracking = timeTracking[projectId];
      if (tracking.snapshots && tracking.snapshots.length > 0) {
        const hasShippedData = Object.values(shippedStats).some(project =>
          project.projectId === projectId || `project_${projectId}` in shippedStats
        );

        if (!hasShippedData) {
          const weeklySnapshots = {};
          tracking.snapshots.forEach(snapshot => {
            if (!weeklySnapshots[snapshot.week]) {
              weeklySnapshots[snapshot.week] = [];
            }
            weeklySnapshots[snapshot.week].push(snapshot);
          });

          const latestWeek = Math.max(...Object.keys(weeklySnapshots).map(w => parseInt(w)));
          const latestWeekSnapshots = weeklySnapshots[latestWeek];
          const latestSnapshot = latestWeekSnapshots[latestWeekSnapshots.length - 1];

          totalUnshippedHours += latestSnapshot.hours;
          unshippedProjects++;

          if (!weekStats[latestSnapshot.week]) {
            weekStats[latestSnapshot.week] = { hours: 0, projects: new Set() };
          }
          weekStats[latestSnapshot.week].hours += latestSnapshot.hours;
        }
      }
    });

    const totalHours = totalShippedHours + totalUnshippedHours;
    const totalProjects = shippedProjects + unshippedProjects;

    const avgCoinsPerHour = totalShippedHours > 0 ? (totalShippedCoins / totalShippedHours) :
      (currentCoins > 0 && totalHours > 0 ? currentCoins / totalHours : 12);

    let avgReviewerBonus = 1.5;
    let avgVoterStars = 3.0;

    if (shippedProjects > 0) {
      const totalReviewerBonus = Object.values(shippedStats).reduce((sum, p) => sum + p.reviewer_bonus, 0);
      const totalVoterStars = Object.values(shippedStats).reduce((sum, p) => sum + p.avg_score, 0);

      avgReviewerBonus = totalReviewerBonus / shippedProjects;
      avgVoterStars = totalVoterStars / shippedProjects;
    }

    const weeksParticipated = totalProjects;
    const totalDays = Math.max(weeksParticipated * 7, 7);
    const avgDailyHours = totalHours / totalDays;

    const statsSection = `
      <div class="home-card-transparent" data-siege-stats="true" style="margin-top: 2rem;">
        <div class="home-card-body-reset">
          <header class="home-header">
            <h2 class="home-section-title">Statistics</h2>
          </header>
          <div class="home-two-col" style="margin-top: 1rem;">
            <div class="home-col">
              <div class="home-list home-list-center">
                <div class="home-row" style="justify-content: space-between; padding: 0.75rem;">
                  <span>Total time under the sun and moon since Week 1:</span>
                  <strong>${utils.formatHours(totalHours)}</strong>
                </div>
                <div class="home-row" style="justify-content: space-between; padding: 0.75rem; border-top: 1px solid rgba(0,0,0,0.1);">
                  <span>Weeks participated:</span>
                  <strong>${weeksParticipated}</strong>
                </div>
                <div class="home-row" style="justify-content: space-between; padding: 0.75rem; border-top: 1px solid rgba(0,0,0,0.1);">
                  <span>Average daily coding:</span>
                  <strong>${utils.formatHours(avgDailyHours)}</strong>
                </div>
              </div>
            </div>
            <div class="home-col">
              <div class="home-list home-list-center">
                <div class="home-row" style="justify-content: space-between; padding: 0.75rem;">
                  <span>Avg reviewer bonus:</span>
                  <strong>×${avgReviewerBonus.toFixed(2)}</strong>
                </div>
                <div class="home-row" style="justify-content: space-between; padding: 0.75rem; border-top: 1px solid rgba(0,0,0,0.1);">
                  <span>Avg voter stars:</span>
                  <strong>${avgVoterStars.toFixed(1)}/5</strong>
                </div>
                <div class="home-row" style="justify-content: space-between; padding: 0.75rem; border-top: 1px solid rgba(0,0,0,0.1);">
                  <span>Coins per hour:</span>
                  <strong>${avgCoinsPerHour.toFixed(1)} 🪙/h</strong>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    `;

    twoColDiv.insertAdjacentHTML('afterend', statsSection);
  }

  function renderMicroGoalCard() {
    if (window.location.pathname !== '/keep') {
      return;
    }

    const removeExisting = () => {
      const existing = document.querySelector('[data-siege-microgoal-card]');
      if (existing) existing.remove();
    };

    removeExisting();

    const storedGoals = goals.getStoredGoals();

    if (!storedGoals || storedGoals.length === 0) {
      const emptyHTML = `
        <div class="home-card-transparent" data-siege-microgoal-card="true" style="margin-top: 2rem;">
          <div class="home-card-body-reset">
            <header class="home-header">
              <h2 class="home-section-title">Micro Goals</h2>
            </header>
            <div style="margin-top: 1rem; padding: 1rem; text-align: center;">
              <p style="font-size: 0.85rem; color: rgba(0,0,0,0.6); margin: 0;">
                Add at least one goal to unlock micro-goal planning.
              </p>
            </div>
          </div>
        </div>
      `;

      const statsSection = document.querySelector('[data-siege-stats]');
      if (statsSection) {
        statsSection.insertAdjacentHTML('beforebegin', emptyHTML);
      }
      return;
    }

    const snapshot = goals.buildMicroGoalSnapshot();

    if (!snapshot) {
      console.warn('[Siege Utils] No snapshot data available for micro goals');
      return;
    }

    const formatNumber = (value, digits = 1) => {
      if (!Number.isFinite(value)) return '0.0';
      return value.toFixed(digits);
    };

    const dailyTarget = snapshot.targets.daily;
    const weeklyTarget = snapshot.targets.weekly;
    const dailyActual = snapshot.progress.dailyActual;
    const weeklyActual = snapshot.progress.weeklyActual;
    const dailyPercent = snapshot.progress.dailyPercent;
    const weeklyPercent = snapshot.progress.weeklyPercent;

    const snapshotRow = (label, target, actual, percent, remainingValue) => `
      <div class="home-row" style="justify-content: space-between; padding: 0.75rem;">
        <span>${label}</span>
        <strong>${formatNumber(actual, 1)}h/${formatNumber(target, 1)}h (${formatNumber(percent, 0)}%)</strong>
      </div>
      <div class="home-row" style="justify-content: space-between; padding: 0.65rem 0.75rem; border-top: 1px solid rgba(0,0,0,0.08);">
        <span>Remaining</span>
        <strong>${formatNumber(Math.max(0, remainingValue), 1)}h</strong>
      </div>
    `;

    const cardHTML = `
      <div class="home-card-transparent" data-siege-microgoal-card="true" style="margin-top: 2rem;">
        <div class="home-card-body-reset">
          <header class="home-header">
            <h2 class="home-section-title">Micro Goals</h2>
          </header>

          <div class="home-two-col" style="margin-top: 1rem;">
            <div class="home-col">
              <div class="home-list home-list-center">
                <div class="home-row" style="padding: 0.75rem; font-weight: 600;">Daily snapshot</div>
                ${snapshotRow('Daily target', dailyTarget, dailyActual, dailyPercent, dailyTarget - dailyActual)}
              </div>
            </div>
            <div class="home-col">
              <div class="home-list home-list-center">
                <div class="home-row" style="padding: 0.75rem; font-weight: 600;">Weekly snapshot</div>
                ${snapshotRow('Weekly target', weeklyTarget, weeklyActual, weeklyPercent, weeklyTarget - weeklyActual)}
              </div>
            </div>
          </div>
        </div>
      </div>
    `;

    const statsSection = document.querySelector('[data-siege-stats]');
    if (statsSection) {
      statsSection.insertAdjacentHTML('beforebegin', cardHTML);
    }

  }

  function addWeeklyBreakdownChart() {
    if (document.querySelector('[data-siege-weekly-chart]')) {
      return;
    }

    const shippedStats = projectStats.getStoredStats();
    const timeTracking = projectStats.getStoredTimeTracking();
    const weeklyData = {};
    const currentWeek = utils.getCurrentWeek();

    Object.values(shippedStats).forEach(project => {
      if (!weeklyData[project.week]) {
        weeklyData[project.week] = { hours: 0, projects: 0 };
      }
      weeklyData[project.week].hours += project.hours;
      weeklyData[project.week].projects++;
    });

    Object.keys(timeTracking).forEach(projectId => {
      const tracking = timeTracking[projectId];
      if (tracking.snapshots && tracking.snapshots.length > 0) {
        const weeklySnapshots = {};
        tracking.snapshots.forEach(snapshot => {
          if (!weeklySnapshots[snapshot.week]) {
            weeklySnapshots[snapshot.week] = [];
          }
          weeklySnapshots[snapshot.week].push(snapshot);
        });

        Object.keys(weeklySnapshots).forEach(week => {
          const weekSnapshots = weeklySnapshots[week];
          const latestSnapshot = weekSnapshots[weekSnapshots.length - 1];
          const hasShippedData = Object.values(shippedStats).some(project =>
            project.week === parseInt(week)
          );

          if (!hasShippedData) {
            if (!weeklyData[week]) {
              weeklyData[week] = { hours: 0, projects: 0 };
            }
            weeklyData[week].hours += latestSnapshot.hours;
            weeklyData[week].projects++;
          }
        });
      }
    });

    const allWeeks = Object.keys(weeklyData).map(w => parseInt(w)).sort((a, b) => a - b);
    if (allWeeks.length === 0) return;

    const minWeek = Math.min(...allWeeks);
    const maxWeek = Math.max(...allWeeks);

    const completeWeeklyData = {};
    for (let week = minWeek; week <= maxWeek; week++) {
      completeWeeklyData[week] = weeklyData[week] || { hours: 0, projects: 0 };
    }

    const hoursSummary = goals.getHoursSummary();
    if (hoursSummary.currentWeekHours > 0) {
      if (!completeWeeklyData[currentWeek]) {
        completeWeeklyData[currentWeek] = { hours: 0, projects: 0 };
      }
      completeWeeklyData[currentWeek].hours = hoursSummary.currentWeekHours;
    }

    const chartData = Object.keys(completeWeeklyData)
      .sort((a, b) => parseInt(a) - parseInt(b))
      .map(week => {
        const weekNum = parseInt(week);
        const weekData = completeWeeklyData[week];

        let coinsPerHour = 0;
        let isCoinsProjected = false;
        const weekShippedProjects = Object.values(shippedStats).filter(project => project.week === weekNum);
        const hasShippedData = weekShippedProjects.length > 0;
        const currentWeek = utils.getCurrentWeek();
        const isHoursProjected = weekNum > currentWeek;

        let projects = [];
        let totalCoins = 0;

        if (hasShippedData) {
          const totalWeekCoins = weekShippedProjects.reduce((sum, p) => sum + p.total_coins, 0);
          const totalWeekHours = weekShippedProjects.reduce((sum, p) => sum + p.hours, 0);
          coinsPerHour = totalWeekHours > 0 ? totalWeekCoins / totalWeekHours : 0;
          isCoinsProjected = false;
          totalCoins = totalWeekCoins;

          projects = weekShippedProjects.map(p => ({
            coins: p.total_coins,
            hours: p.hours
          }));
        } else if (weekData.hours > 0) {
          coinsPerHour = weekNum >= 5 ? goals.getWeek5PlusEfficiency() : projectStats.getAverageEfficiency();
          isCoinsProjected = true;
          totalCoins = Math.round(weekData.hours * coinsPerHour);
        } else {
          coinsPerHour = 0;
          isCoinsProjected = false;
          totalCoins = 0;
        }

        return {
          week: weekNum,
          hours: weekData.hours,
          coinsPerHour,
          totalCoins,
          label: `Week ${week}`,
          isProjected: isCoinsProjected,
          isCoinsProjected,
          isHoursProjected,
          projects
        };
      });
    const avgEfficiency = projectStats.getAverageEfficiency();

    const futureWeek = currentWeek + 1;

    const allHistoricalEfficiency = chartData
      .filter(d => !d.isCoinsProjected && d.coinsPerHour > 0)
      .map(d => d.coinsPerHour);

    let futureWeekEfficiency = futureWeek >= 5 ? goals.getWeek5PlusEfficiency() : avgEfficiency;

    if (allHistoricalEfficiency.length > 0) {
      const efficiencyPrediction = bettingPredictor.predictPersonalEfficiency(allHistoricalEfficiency);
      futureWeekEfficiency = Math.round(efficiencyPrediction.prediction * 0.9 * 10) / 10;
    }

    let futureWeekHours = 10;

    const allHistoricalHours = chartData
      .filter(d => !d.isHoursProjected && d.hours > 0)
      .map(d => d.hours);

    if (allHistoricalHours.length > 0) {
      const prediction = bettingPredictor.predictPersonalHours(allHistoricalHours);
      futureWeekHours = Math.round(prediction.prediction * 10) / 10;

      const currentWeekData = chartData.find(d => d.week === currentWeek);
      if (currentWeekData && !currentWeekData.isHoursProjected) {
        const now = new Date();
        const dayOfWeek = now.getDay();
        const daysElapsed = dayOfWeek === 0 ? 7 : dayOfWeek;

        if (daysElapsed < 7 && currentWeekData.hours < futureWeekHours * 0.7) {
          const dailyPace = currentWeekData.hours / daysElapsed;
          const projectedCurrentWeek = dailyPace * 7;

          futureWeekHours = (futureWeekHours * 0.6) + (projectedCurrentWeek * 0.4);
          futureWeekHours = Math.round(futureWeekHours * 10) / 10;
        }
      }
    }

    chartData.push({
      week: futureWeek,
      hours: futureWeekHours,
      coinsPerHour: futureWeekHours > 0 ? futureWeekEfficiency : 0,
      label: `Week ${futureWeek}`,
      isProjected: true,
      isCoinsProjected: futureWeekHours > 0,
      isHoursProjected: true
    });

    const totalHours = chartData.reduce((sum, d) => sum + d.hours, 0);

    const upcomingWeek = currentWeek + 1;
    const weeksWithoutUpcoming = chartData.filter(d => !(d.week === upcomingWeek && d.isCoinsProjected && d.isHoursProjected));
    const displayMaxWeek = weeksWithoutUpcoming.length > 0 ? Math.max(...weeksWithoutUpcoming.map(d => d.week)) : chartData[chartData.length - 1]?.week || currentWeek;
    const currentYear = new Date().getFullYear();

    const legendMarkup = `
                <div class="siege-weekly-legend" style="display: inline-flex; gap: 0.85rem; align-items: center; flex-wrap: wrap; font-size: 0.75rem; color: #1f2937;">
                  <span style="display: inline-flex; align-items: center; gap: 0.4rem;">
                    <span style="width: 10px; height: 10px; border-radius: 3px; background: #34d399;"></span>
                    <span>Hours tracked</span>
                  </span>
                  <span style="display: inline-flex; align-items: center; gap: 0.4rem;">
                    <span style="width: 10px; height: 10px; border-radius: 3px; background: #60a5fa;"></span>
                    <span>🪙/h earned</span>
                  </span>
                  <span style="display: inline-flex; align-items: center; gap: 0.4rem;">
                    <span style="width: 10px; height: 10px; border-radius: 3px; background: #f59e0b;"></span>
                    <span>Total coins</span>
                  </span>
                  <span style="display: inline-flex; align-items: center; gap: 0.4rem;">
                    <span style="width: 10px; height: 10px; border-radius: 3px; border: 1px dashed rgba(148, 163, 184, 0.8); background: rgba(148, 163, 184, 0.12);"></span>
                    <span>Projected</span>
                  </span>
                </div>
              `;

    const createRechartsChart = () => {
      const chartId = 'siege-weekly-chart-' + Date.now();

      return `
        <section data-siege-weekly-chart="true" class="home-card-transparent siege-weekly-card" style="margin-top: 2.5rem; margin-left: 2rem; max-width: calc(100% - 2rem); background: rgba(255, 255, 255, 0.14); border: none; border-radius: 1rem; box-shadow: 0 24px 48px -32px rgba(15, 23, 42, 0.18); backdrop-filter: blur(12px);">
          <div class="home-card-body-reset" style="padding: 1.75rem;">
            <div class="home-header" style="display: flex; justify-content: space-between; align-items: flex-start; flex-wrap: wrap; gap: 1.5rem;">
              <div>
                <h3 class="home-section-title" style="margin: 0; font-size: 2rem; color: #0f172a;">Weekly Efficiency</h3>
                <p style="margin: 0.35rem 0 0; font-size: 0.82rem; color: #6b7280;">Week ${minWeek} – Week ${displayMaxWeek} ${currentYear}</p>
              </div>
${legendMarkup}
            </div>
            <div style="margin-top: 1.5rem;">
              <div style="background: rgba(255, 255, 255, 0.05); border: 1px solid rgba(226, 232, 240, 0.6); border-radius: 0.9rem; padding: 1.25rem;">
                <div id="${chartId}" style="height: 220px; width: 100%;"></div>
              </div>
            </div>
          </div>
        </section>
      `;
    };

    const statsSection = document.querySelector('[data-siege-stats]');
    if (!statsSection) return;

    const chartHTML = createRechartsChart();
    const chartId = chartHTML.match(/id="([^"]+)"/)[1];

    statsSection.insertAdjacentHTML('afterend', chartHTML);

    setTimeout(() => {
      initializeChart(chartId, chartData);
    }, 100);
  }

  function initializeChart(chartId, chartData) {
    const container = document.getElementById(chartId);
    if (!container) {
      console.error('Chart container not found');
      return;
    }

    if (!window.Chart) {
      console.error('Chart.js not loaded');
      return;
    }
    createChart(container, chartData, chartId);
  }

  function createChart(container, chartData, chartId) {
    const canvas = document.createElement('canvas');
    canvas.id = chartId + '-canvas';
    canvas.style.maxHeight = '200px';

    container.innerHTML = '';
    container.appendChild(canvas);

    const ctx = canvas.getContext('2d');

    const labels = chartData.map(d => `W${d.week}`);
    const hoursData = chartData.map(d => d.hours);
    const coinsData = chartData.map(d => d.coinsPerHour);
    const totalCoinsData = chartData.map(d => d.totalCoins);

    const maxHours = Math.max(...hoursData.filter(h => h !== null && h !== undefined));

    const validCoinsData = coinsData.filter((c, idx) => {
      const hours = hoursData[idx];
      return c !== null && c !== undefined && hours > 0;
    });
    const maxCoins = validCoinsData.length > 0 ? Math.max(...validCoinsData) : 0;
    const validTotalCoinsData = totalCoinsData.filter(c => c !== null && c !== undefined && c > 0);
    const maxTotalCoins = validTotalCoinsData.length > 0 ? Math.max(...validTotalCoinsData) : 0;

    const hoursSuggestedMax = Math.max(16, Math.ceil(maxHours / 4) * 4);

    const coinsSuggestedMax = Math.max(4, Math.ceil(maxCoins / 4) * 4);

    const totalCoinsSuggestedMax = Math.max(100, Math.ceil(maxTotalCoins / 100) * 100);

    new Chart(ctx, {
      type: 'line',
      data: {
        labels,
        datasets: [
          {
            data: hoursData,
            borderColor: '#34d399',
            backgroundColor: (context) => {
              const ctx = context.chart.ctx;
              const gradient = ctx.createLinearGradient(0, 0, 0, context.chart.height);
              gradient.addColorStop(0, 'rgba(52, 211, 153, 0.05)');
              gradient.addColorStop(0.5, 'rgba(52, 211, 153, 0.25)');
              gradient.addColorStop(1, 'rgba(52, 211, 153, 0.4)');
              return gradient;
            },
            borderWidth: 2,
            fill: 'origin',
            tension: 0.25,
            pointBackgroundColor: (ctx) => chartData[ctx.dataIndex]?.isHoursProjected ? '#ffffff' : '#34d399',
            pointBorderColor: '#34d399',
            pointBorderWidth: 2,
            pointRadius: (ctx) => chartData[ctx.dataIndex]?.isHoursProjected ? 4 : 5,
            pointHoverRadius: 7,
            yAxisID: 'y',
            segment: {
              borderDash: (ctx) => {
                const startHoursProjected = chartData[ctx.p0DataIndex]?.isHoursProjected;
                const endHoursProjected = chartData[ctx.p1DataIndex]?.isHoursProjected;
                return startHoursProjected || endHoursProjected ? [6, 6] : undefined;
              }
            }
          },
          {
            data: coinsData,
            borderColor: '#60a5fa',
            backgroundColor: (context) => {
              const ctx = context.chart.ctx;
              const gradient = ctx.createLinearGradient(0, 0, 0, context.chart.height);
              gradient.addColorStop(0, 'rgba(96, 165, 250, 0.4)');
              gradient.addColorStop(0.5, 'rgba(96, 165, 250, 0.25)');
              gradient.addColorStop(1, 'rgba(96, 165, 250, 0.05)');
              return gradient;
            },
            borderWidth: 2,
            fill: 'origin',
            tension: 0.25,
            pointBackgroundColor: (ctx) => chartData[ctx.dataIndex]?.isCoinsProjected ? '#ffffff' : '#60a5fa',
            pointBorderColor: '#60a5fa',
            pointBorderWidth: 2,
            pointRadius: (ctx) => chartData[ctx.dataIndex]?.isCoinsProjected ? 4 : 5,
            pointHoverRadius: 7,
            yAxisID: 'y1',
            segment: {
              borderDash: (ctx) => {
                const startProjected = chartData[ctx.p0DataIndex]?.isCoinsProjected || chartData[ctx.p0DataIndex]?.isProjected || false;
                const endProjected = chartData[ctx.p1DataIndex]?.isCoinsProjected || chartData[ctx.p1DataIndex]?.isProjected || false;
                return startProjected && endProjected ? [6, 6] : undefined;
              }
            }
          },
          {
            data: totalCoinsData,
            borderColor: '#f59e0b',
            backgroundColor: (context) => {
              const ctx = context.chart.ctx;
              const gradient = ctx.createLinearGradient(0, 0, 0, context.chart.height);
              gradient.addColorStop(0, 'rgba(245, 158, 11, 0.4)');
              gradient.addColorStop(0.5, 'rgba(245, 158, 11, 0.25)');
              gradient.addColorStop(1, 'rgba(245, 158, 11, 0.05)');
              return gradient;
            },
            borderWidth: 2,
            fill: 'origin',
            tension: 0.25,
            pointBackgroundColor: (ctx) => chartData[ctx.dataIndex]?.isCoinsProjected ? '#ffffff' : '#f59e0b',
            pointBorderColor: '#f59e0b',
            pointBorderWidth: 2,
            pointRadius: (ctx) => chartData[ctx.dataIndex]?.isCoinsProjected ? 4 : 5,
            pointHoverRadius: 7,
            yAxisID: 'y2',
            segment: {
              borderDash: (ctx) => {
                const startProjected = chartData[ctx.p0DataIndex]?.isCoinsProjected || chartData[ctx.p0DataIndex]?.isProjected || false;
                const endProjected = chartData[ctx.p1DataIndex]?.isCoinsProjected || chartData[ctx.p1DataIndex]?.isProjected || false;
                return startProjected && endProjected ? [6, 6] : undefined;
              }
            }
          }
        ]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        interaction: {
          mode: 'index',
          intersect: false
        },
        scales: {
          x: {
            display: true,
            grid: {
              color: 'rgba(203, 213, 225, 0.5)'
            },
            ticks: {
              color: '#334155',
              font: {
                size: 11,
                weight: '500'
              }
            },
            border: {
              display: false
            }
          },
          y: {
            type: 'linear',
            display: true,
            position: 'left',
            min: 0,
            suggestedMax: hoursSuggestedMax,
            title: {
              display: true,
              text: 'Hours Tracked',
              color: '#10b981',
              font: {
                size: 12,
                weight: '700'
              }
            },
            grid: {
              color: 'rgba(52, 211, 153, 0.25)'
            },
            ticks: {
              stepSize: 4,
              color: '#10b981',
              font: {
                size: 11,
                weight: '600'
              }
            },
            border: {
              display: false
            }
          },
          y1: {
            type: 'linear',
            display: true,
            position: 'right',
            min: 0,
            suggestedMax: coinsSuggestedMax,
            title: {
              display: true,
              text: 'Coins/Hour',
              color: '#3b82f6',
              font: {
                size: 12,
                weight: '700'
              }
            },
            grid: {
              drawOnChartArea: false
            },
            ticks: {
              stepSize: 4,
              color: '#3b82f6',
              font: {
                size: 11,
                weight: '600'
              }
            },
            border: {
              display: false
            }
          },
          y2: {
            type: 'linear',
            display: true,
            position: 'right',
            min: 0,
            suggestedMax: totalCoinsSuggestedMax,
            title: {
              display: true,
              text: 'Total Coins',
              color: '#d97706',
              font: {
                size: 12,
                weight: '700'
              }
            },
            grid: {
              drawOnChartArea: false
            },
            ticks: {
              stepSize: 4,
              color: '#d97706',
              font: {
                size: 11,
                weight: '600'
              }
            },
            border: {
              display: false
            }
          }
        },
        plugins: {
          legend: {
            display: false
          },
          tooltip: {
            backgroundColor: '#ffffff',
            titleColor: '#0f172a',
            bodyColor: '#334155',
            borderColor: 'rgba(148, 163, 184, 0.6)',
            borderWidth: 1,
            cornerRadius: 9,
            padding: 12,
            displayColors: false,
            callbacks: {
              label(context) {
                const dataIndex = context.dataIndex;
                const meta = chartData[dataIndex] || {};
                const datasetIndex = context.datasetIndex;

                if (datasetIndex === 0) {
                  return `Hours: ${context.parsed.y.toFixed(1)}h`;
                } else if (datasetIndex === 1) {
                  const suffix = meta.isCoinsProjected ? ' (projected)' : '';
                  return `🪙/h: ${context.parsed.y.toFixed(2)} 🪙/h${suffix}`;
                } else if (datasetIndex === 2) {
                  const suffix = meta.isCoinsProjected ? ' (projected)' : '';
                  return `Coins: ${utils.formatCoins(context.parsed.y)}${suffix}`;
                }
              },
              afterBody(context) {
                if (context.length === 0) return [];
                const dataIndex = context[0].dataIndex;
                const meta = chartData[dataIndex] || {};

                if (!meta.projects || meta.projects.length === 0) {
                  return [];
                }

                const lines = [''];
                meta.projects.forEach((project, idx) => {
                  const coinsFormatted = utils.formatCoins(project.coins);
                  lines.push(`Project ${idx + 1}: ${coinsFormatted} (${project.hours.toFixed(1)}h)`);
                });

                return lines;
              }
            }
          }
        }
      }
    });
  }

  function addWeeklyHoursPlanner() {
    if (document.querySelector('[data-siege-hours-planner]')) {
      return;
    }

    const footer = document.querySelector('.home-progress-footer');
    if (!footer) {
      setTimeout(() => addWeeklyHoursPlanner(), 300);
      return;
    }

    const hoursSummary = goals.getHoursSummary();
    const currentWeekHours = Number.isFinite(hoursSummary.currentWeekHours) ? hoursSummary.currentWeekHours : 0;
    const todayLoggedHours = Number.isFinite(hoursSummary.todayHours) ? hoursSummary.todayHours : null;
    const currentWeek = utils.getCurrentWeek();

    const savedConfig = localStorage.getItem('siegeutils_weeklydata');
    let config = savedConfig ? JSON.parse(savedConfig) : {
      workDays: [true, true, true, true, true, true, true],
      fixedHours: [0, 0, 0, 0, 0, 0, 0],
      persistAcrossWeeks: false,
      savedWeek: currentWeek
    };

    if (!config.persistAcrossWeeks && config.savedWeek !== currentWeek) {
      config = {
        workDays: [true, true, true, true, true, true, true],
        fixedHours: [0, 0, 0, 0, 0, 0, 0],
        persistAcrossWeeks: false,
        savedWeek: currentWeek
      };
      localStorage.setItem('siegeutils_weeklydata', JSON.stringify(config));
    }

    const weekGoal = 10;
    const remainingHours = Math.max(0, weekGoal - currentWeekHours);

    const now = new Date();
    const dayOfWeek = (now.getDay() + 6) % 7;

    function calculateDailyHours() {
      const todayPlannedHours = config.fixedHours[dayOfWeek] > 0
        ? config.fixedHours[dayOfWeek]
        : 0;
      const todayIsWorkDay = config.workDays[dayOfWeek];
      const todayActualHours = todayLoggedHours !== null ? todayLoggedHours : 0;

      let futurePlannedHours = 0;
      let futureFlexibleDays = 0;

      for (let i = dayOfWeek + 1; i < 7; i++) {
        if (config.fixedHours[i] > 0) {
          futurePlannedHours += config.fixedHours[i];
        } else if (config.workDays[i]) {
          futureFlexibleDays++;
        }
      }

      let remainingAfterToday = remainingHours;

      if (todayPlannedHours > 0) {
        remainingAfterToday = Math.max(0, remainingAfterToday - todayPlannedHours);
      }

      const remainingAfterFuture = Math.max(0, remainingAfterToday - futurePlannedHours);

      const totalFlexibleDays = futureFlexibleDays + (todayIsWorkDay && todayPlannedHours === 0 ? 1 : 0);
      const hoursPerFlexDay = totalFlexibleDays > 0 ? remainingAfterFuture / totalFlexibleDays : 0;

      return {
        hoursPerFlexDay,
        totalFlexibleDays,
        futureFlexibleDays,
        todayPlannedHours,
        todayIsWorkDay,
        todayActualHours
      };
    }

    const {
      hoursPerFlexDay,
      totalFlexibleDays,
      futureFlexibleDays,
      todayPlannedHours,
      todayIsWorkDay,
      todayActualHours
    } = calculateDailyHours();

    let todayTargetHours;
    let todayRemainingHours;

    if (todayPlannedHours > 0) {
      todayTargetHours = todayPlannedHours;
      todayRemainingHours = Math.max(0, todayTargetHours - todayActualHours);
    } else if (futureFlexibleDays === 0 && todayIsWorkDay && remainingHours > 0) {
      todayTargetHours = todayActualHours + remainingHours;
      todayRemainingHours = remainingHours;
    } else if (todayIsWorkDay) {
      todayTargetHours = hoursPerFlexDay;
      todayRemainingHours = Math.max(0, todayTargetHours - todayActualHours);
    } else {
      todayTargetHours = 0;
      todayRemainingHours = 0;
    }

    const dayNames = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

    const plannerHTML = `
      <details data-siege-hours-planner="true" style="
        margin: 0.75rem 0 0.75rem 2rem;
        padding: 0;
        background: rgba(255, 255, 255, 0.08);
        border: 2px solid rgba(64, 43, 32, 0.65);
        border-radius: 0.75rem;
        box-shadow: 0 2px 8px rgba(0, 0, 0, 0.1);
      ">
        <summary style="
          cursor: pointer;
          padding: 0.75rem 1rem;
          display: flex;
          justify-content: space-between;
          align-items: center;
          list-style: none;
          user-select: none;
        ">
          <div style="display: flex; align-items: center; gap: 0.5rem; flex-wrap: wrap;">
            <span style="font-size: 1.1rem; font-weight: 600; color: #3b2a1a;">
              📅 Weekly Hours Planner
            </span>
            <span style="font-size: 0.85rem; color: #6b5437;">
              (<span style="font-weight: 600;">${currentWeekHours.toFixed(1)}h</span> / ${weekGoal}h)
            </span>
            ${(() => {
        if (remainingHours <= 0) return '';

        const parts = [];

        if (todayIsWorkDay) {
          if (todayLoggedHours !== null && todayLoggedHours > 0) {
            parts.push(`${todayLoggedHours.toFixed(1)}h logged today`);
          }

          if (todayRemainingHours > 0) {
            parts.push(`${todayRemainingHours.toFixed(1)}h pending today`);
          } else if (todayLoggedHours === null && todayTargetHours > 0) {
            parts.push(`${todayTargetHours.toFixed(1)}h goal today`);
          }
        }

        if (futureFlexibleDays > 0 && hoursPerFlexDay > 0) {
          parts.push(`${hoursPerFlexDay.toFixed(1)}h/day for ${futureFlexibleDays} day${futureFlexibleDays !== 1 ? 's' : ''}`);
        }

        return parts.length > 0 ? `
                <span style="font-size: 0.8rem; color: #047857; font-weight: 500;">
                  • ${parts.join(' • ')}
                </span>
              ` : '';
      })()}
          </div>
          <span id="planner-arrow" style="font-size: 0.75rem; color: #6b5437; transition: transform 0.4s cubic-bezier(0.4, 0, 0.2, 1);">▼</span>
        </summary>
        <div style="padding: 0 1.25rem 1.25rem 1.25rem;">

        <div style="background: rgba(52, 211, 153, 0.1); border: 1px solid rgba(52, 211, 153, 0.3); border-radius: 0.5rem; padding: 0.75rem; margin-bottom: 1rem; text-align: center;">
          <div style="font-size: 1.1rem; font-weight: 600; color: #059669; margin-bottom: 0.25rem;">
            ${remainingHours > 0 ? `${remainingHours.toFixed(1)}h remaining this week` : '✅ Goal reached!'}
          </div>
          ${remainingHours > 0 ? `
            <div style="font-size: 0.85rem; color: #047857;">
              ${todayRemainingHours > 0
          ? `${todayRemainingHours.toFixed(1)}h pending today${futureFlexibleDays > 0 ? `, ~${hoursPerFlexDay.toFixed(1)}h/day for ${futureFlexibleDays} future day${futureFlexibleDays !== 1 ? 's' : ''}` : ''}`
          : futureFlexibleDays > 0
            ? `~${hoursPerFlexDay.toFixed(1)}h per flexible day (${futureFlexibleDays} day${futureFlexibleDays !== 1 ? 's' : ''})`
            : 'All set for today!'
        }
            </div>
          ` : ''}
        </div>

        <div id="daily-breakdown" style="display: grid; grid-template-columns: repeat(7, 1fr); gap: 0.5rem; margin-bottom: 1rem;">
          ${dayNames.map((day, i) => {
          const isPast = i < dayOfWeek;
          const isToday = i === dayOfWeek;
          const isWorkDay = config.workDays[i];
          const fixedHours = config.fixedHours[i];
          let displayValue;
          if (isPast) {
            displayValue = '-';
          } else if (isToday && todayLoggedHours !== null) {
            displayValue = `${todayLoggedHours.toFixed(1)}h`;
          } else if (fixedHours > 0) {
            displayValue = `${fixedHours.toFixed(1)}h`;
          } else if (isWorkDay) {
            displayValue = `${hoursPerFlexDay.toFixed(1)}h`;
          } else {
            displayValue = '0h';
          }

          const statusLabel = isPast ? '' : (isToday && todayLoggedHours !== null
            ? 'Logged'
            : (fixedHours > 0 ? 'Fixed' : (isWorkDay ? 'Flex' : 'Off')));

          const amountColor = isPast
            ? '#9ca3af'
            : (isToday && todayLoggedHours !== null
              ? '#2563eb'
              : (isWorkDay ? '#059669' : '#dc2626'));

          return `
              <div style="
                padding: 0.5rem;
                background: ${isPast ? 'rgba(0,0,0,0.1)' : (isToday ? 'rgba(59, 130, 246, 0.1)' : 'rgba(255,255,255,0.05)')};
                border: 2px solid ${isPast ? 'rgba(0,0,0,0.2)' : (isToday ? 'rgba(59, 130, 246, 0.4)' : (isWorkDay ? 'rgba(52, 211, 153, 0.3)' : 'rgba(239, 68, 68, 0.3)'))};
                border-radius: 0.5rem;
                text-align: center;
                opacity: ${isPast ? '0.5' : '1'};
              ">
                <div style="font-size: 0.7rem; font-weight: 600; color: #6b5437; margin-bottom: 0.25rem;">
                  ${day}${isToday ? ' 📍' : ''}
                </div>
                <div style="font-size: 0.9rem; font-weight: 700; color: ${amountColor};">
                  ${displayValue}
                </div>
                ${!isPast ? `
                  <div style="font-size: 0.65rem; color: #6b5437; margin-top: 0.25rem;">
                    ${statusLabel}
                  </div>
                ` : ''}
              </div>
            `;
        }).join('')}
        </div>

        <details style="margin-top: 1rem;">
          <summary style="cursor: pointer; font-size: 0.9rem; font-weight: 600; color: #6b5437; padding: 0.5rem; background: rgba(0,0,0,0.05); border-radius: 0.5rem;">
            ⚙️ Configure Schedule
          </summary>
          <div id="schedule-config" style="margin-top: 1rem; padding: 1rem; background: rgba(0,0,0,0.03); border-radius: 0.5rem;">
            ${dayNames.map((day, i) => `
              <div style="display: flex; align-items: center; gap: 1rem; margin-bottom: 0.75rem; padding: 0.5rem; background: rgba(255,255,255,0.5); border-radius: 0.5rem;">
                <label style="display: flex; align-items: center; gap: 0.5rem; min-width: 80px;">
                  <input
                    type="checkbox"
                    id="workday-${i}"
                    ${config.workDays[i] ? 'checked' : ''}
                    ${i < dayOfWeek ? 'disabled' : ''}
                    style="width: 16px; height: 16px; cursor: pointer;"
                  >
                  <span style="font-size: 0.85rem; font-weight: 600;">${day}</span>
                </label>
                <label style="display: flex; align-items: center; gap: 0.5rem; flex: 1;">
                  <span style="font-size: 0.75rem; color: #6b5437;">Fixed:</span>
                  <input
                    type="number"
                    id="fixed-hours-${i}"
                    value="${config.fixedHours[i]}"
                    min="0"
                    max="24"
                    step="0.5"
                    ${i < dayOfWeek ? 'disabled' : ''}
                    style="width: 60px; padding: 0.25rem; border: 1px solid rgba(64, 43, 32, 0.3); border-radius: 0.25rem; font-size: 0.85rem;"
                  >
                  <span style="font-size: 0.75rem; color: #6b5437;">hours</span>
                </label>
              </div>
            `).join('')}

            <div style="margin-top: 1rem; padding: 0.75rem; background: rgba(59, 130, 246, 0.08); border: 1px solid rgba(59, 130, 246, 0.2); border-radius: 0.5rem;">
              <label style="display: flex; align-items: center; gap: 0.75rem; cursor: pointer;">
                <input
                  type="checkbox"
                  id="persist-schedule"
                  ${config.persistAcrossWeeks ? 'checked' : ''}
                  style="width: 18px; height: 18px; cursor: pointer;"
                >
                <div style="flex: 1;">
                  <div style="font-size: 0.85rem; font-weight: 600; color: #1e40af;">
                    Keep schedule across weeks
                  </div>
                  <div style="font-size: 0.7rem; color: #60a5fa; margin-top: 0.15rem;">
                    If unchecked, schedule resets every week
                  </div>
                </div>
              </label>
            </div>

            <button id="save-schedule" style="
              margin-top: 1rem;
              width: 100%;
              padding: 0.5rem 1rem;
              background: linear-gradient(135deg, #34d399, #059669);
              color: white;
              font-weight: 600;
              border: none;
              border-radius: 0.5rem;
              cursor: pointer;
              font-size: 0.9rem;
            ">
              Save Schedule
            </button>
          </div>
        </details>
        </div>
      </details>
    `;

    const countdownContainer = document.getElementById('time-till-next-week-container');
    if (countdownContainer) {
      countdownContainer.insertAdjacentHTML('beforebegin', plannerHTML);
    } else {
      footer.insertAdjacentHTML('beforeend', plannerHTML);
    }

    document.getElementById('save-schedule')?.addEventListener('click', () => {
      const persistCheckbox = document.getElementById('persist-schedule');
      const newConfig = {
        workDays: [],
        fixedHours: [],
        persistAcrossWeeks: persistCheckbox?.checked || false,
        savedWeek: currentWeek
      };

      for (let i = 0; i < 7; i++) {
        const workdayCheckbox = document.getElementById(`workday-${i}`);
        const fixedHoursInput = document.getElementById(`fixed-hours-${i}`);

        newConfig.workDays[i] = workdayCheckbox?.checked || false;
        newConfig.fixedHours[i] = parseFloat(fixedHoursInput?.value || '0');
      }

      localStorage.setItem('siegeutils_weeklydata', JSON.stringify(newConfig));

      document.querySelector('[data-siege-hours-planner]')?.remove();
      addWeeklyHoursPlanner();

      components.showToast('Schedule saved! ✅');
    });
  }

  function initCountdownTimer() {
    const footer = document.querySelector('.home-progress-footer');
    if (!footer) return;

    let countdownContainer = document.getElementById('time-till-next-week-container');
    if (!countdownContainer) {
      countdownContainer = document.createElement('div');
      countdownContainer.className = 'home-progress-bottom';
      countdownContainer.id = 'time-till-next-week-container';
      footer.appendChild(countdownContainer);
    }

    countdownContainer.innerHTML = `
        Next week in: <span id="time-till-next-week"></span>
    `;

    updateCountdown();
    setInterval(updateCountdown, 60000);
  }

  function updateCountdown() {
    const countdownElement = document.getElementById('time-till-next-week');
    if (!countdownElement) return;

    const now = new Date();

    let nextMonday = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 4, 0, 0));

    while (nextMonday.getUTCDay() !== 1) {
      nextMonday.setUTCDate(nextMonday.getUTCDate() + 1);
    }

    if (nextMonday.getTime() < now.getTime()) {
      nextMonday.setUTCDate(nextMonday.getUTCDate() + 7);
    }

    const diff = nextMonday.getTime() - now.getTime();

    if (diff > 0) {
      const days = Math.floor(diff / (1000 * 60 * 60 * 24));
      const hours = Math.floor((diff % (1000 * 60 * 60 * 24)) / (1000 * 60 * 60));
      const minutes = Math.floor((diff % (1000 * 60 * 60)) / (1000 * 60));

      countdownElement.textContent = `${days}d ${hours}h ${minutes}m`;
    } else {
      countdownElement.textContent = "The new week has begun!";
    }
  }

  function removeMarketDialogueElements(root = document) {
    if (!root || typeof root.querySelectorAll !== 'function') {
      return;
    }

    const nodes = root.querySelectorAll('#market-dialogue, .market-dialogue');
    nodes.forEach((node) => {
      if (node && node.parentNode) {
        node.parentNode.removeChild(node);
      }
    });
  }

  function ensureMarketDialogueCleanup() {
    removeMarketDialogueElements(document);

    if (marketDialogueObserver || !document.body) {
      return;
    }

    marketDialogueObserver = new MutationObserver((mutations) => {
      let shouldClean = false;

      for (const mutation of mutations) {
        if (mutation.type === 'childList') {
          mutation.addedNodes.forEach((node) => {
            if (!node || node.nodeType !== 1) {
              return;
            }

            if (node.id === 'market-dialogue') {
              shouldClean = true;
            } else if (node.classList && node.classList.contains('market-dialogue')) {
              shouldClean = true;
            } else if (typeof node.querySelector === 'function' && node.querySelector('#market-dialogue, .market-dialogue')) {
              shouldClean = true;
            }
          });
        } else if (mutation.type === 'attributes' && mutation.target) {
          const target = mutation.target;
          if (target.id === 'market-dialogue' || (target.classList && target.classList.contains('market-dialogue'))) {
            shouldClean = true;
          }
        }

        if (shouldClean) {
          break;
        }
      }

      if (shouldClean) {
        removeMarketDialogueElements(document);
      }
    });

    marketDialogueObserver.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['class', 'id']
    });
  }

  function teardownMarketDialogueCleanup() {
    if (marketDialogueObserver) {
      marketDialogueObserver.disconnect();
      marketDialogueObserver = null;
    }

    const styleEl = document.getElementById(MARKET_DIALOGUE_STYLE_ID);
    if (styleEl && styleEl.parentNode) {
      styleEl.parentNode.removeChild(styleEl);
    }
  }

  async function enhanceShopPage() {
    if (window.location.pathname !== '/shop') return;

    ensureMarketDialogueCleanup();

    const shopItems = await shopUtils.getShopItems();

    if (shopItems) {
      window.siegeUtilsShopItems = shopItems;
    }
  }

  function addCastleTooltips() {
    if (window.location.pathname !== '/castle') return;
    if (document.querySelector('.siege-castle-tooltip')) return;


    const tooltip = document.createElement('div');
    tooltip.className = 'siege-castle-tooltip';
    document.body.appendChild(tooltip);

    const areaLabels = {
      'keep': 'Keep',
      'great-hall': 'Great Hall',
      'armory': 'Armory',
      'market': 'Market',
      'chambers': 'Chambers',
      'map': 'Map'
    };

    setTimeout(() => {
      Object.keys(areaLabels).forEach(id => {
        const svgPath = document.querySelector(`.hover-box svg path#${id}`);
        if (!svgPath) return;

        svgPath.addEventListener('mouseenter', (e) => {
          tooltip.textContent = areaLabels[id];
          tooltip.classList.add('visible');
        });

        svgPath.addEventListener('mousemove', (e) => {
          tooltip.style.left = (e.clientX + 15) + 'px';
          tooltip.style.top = (e.clientY + 15) + 'px';
        });

        svgPath.addEventListener('mouseleave', () => {
          tooltip.classList.remove('visible');
        });
      });
    }, 500);
  }

  function handleNavigation() {
    if (window.location.pathname !== lastPath) {
      lastPath = window.location.pathname;

      if (navigationTimeout) {
        clearTimeout(navigationTimeout);
      }

      navigationTimeout = setTimeout(() => {
        if (window.location.pathname.startsWith('/market')) {
          init();
        } else {
          isActive = false;
        }

        if (window.location.pathname === '/shop') {
          enhanceShopPage();
        } else if (window.location.pathname.startsWith('/market')) {
          ensureMarketDialogueCleanup();
        } else {
          teardownMarketDialogueCleanup();
        }

        if (window.location.pathname === '/castle') {
          addCastleTooltips();
        }

        initProjectStats();
        initKeepEnhancements();
        leaderboardRanking.displayRankInNavbar();
        navigationTimeout = null;
      }, 300);
    }
  }

  document.addEventListener('turbo:load', handleNavigation);
  document.addEventListener('turbo:render', handleNavigation);
  document.addEventListener('turbo:visit', handleNavigation);
  document.addEventListener('turbo:frame-load', handleNavigation);

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => {
      setTimeout(() => leaderboardRanking.displayRankInNavbar(), 500);
    });
  } else {
    setTimeout(() => leaderboardRanking.displayRankInNavbar(), 500);
  }

  document.addEventListener('turbolinks:load', handleNavigation);
  document.addEventListener('turbolinks:render', handleNavigation);
  document.addEventListener('turbolinks:visit', handleNavigation);

  new MutationObserver(handleNavigation).observe(document.body, { childList: true, subtree: true });
  window.addEventListener('popstate', handleNavigation);

  const originalPushState = history.pushState;
  const originalReplaceState = history.replaceState;

  history.pushState = function () {
    originalPushState.apply(history, arguments);
    setTimeout(handleNavigation, 50);
  };

  history.replaceState = function () {
    originalReplaceState.apply(history, arguments);
    setTimeout(handleNavigation, 50);
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => {
      if (window.location.pathname.startsWith('/market')) {
        init();
      }
      if (window.location.pathname === '/shop') {
        enhanceShopPage();
      } else if (window.location.pathname.startsWith('/market')) {
        ensureMarketDialogueCleanup();
      } else {
        teardownMarketDialogueCleanup();
      }
      if (window.location.pathname === '/castle') {
        addCastleTooltips();
      }
      initProjectStats();
      initKeepEnhancements();
    });
  } else {
    if (window.location.pathname.startsWith('/market')) {
      init();
    }
    if (window.location.pathname === '/shop') {
      enhanceShopPage();
    } else if (window.location.pathname.startsWith('/market')) {
      ensureMarketDialogueCleanup();
    } else {
      teardownMarketDialogueCleanup();
    }
    if (window.location.pathname === '/castle') {
      addCastleTooltips();
    }
    initProjectStats();
    initKeepEnhancements();
  }
}

function applyTheme(theme, disableHues = false, customColors = {}, customHue = {}) {
  const existingThemeLink = document.getElementById('siege-utils-theme');
  const existingCustomStyle = document.getElementById('siege-utils-custom');
  const existingHueStyle = document.getElementById('siege-utils-custom-hue');

  if (theme === 'catppuccin' || theme === 'custom' || theme === 'signal' || theme === 'spooky' || theme === 'winter' || theme === 'slack') {

    let cssFile = 'catppuccin.css';
    if (theme === 'signal') {
      cssFile = 'signal.css';
    } else if (theme === 'spooky') {
      cssFile = 'spooky.css';
    } else if (theme === 'winter') {
      cssFile = 'winter.css';
    } else if (theme === 'slack') {
      cssFile = 'slack.css';
    }

    const cssUrl = browserAPI.runtime.getURL(cssFile);

    if (!existingThemeLink) {
      const link = document.createElement('link');
      link.id = 'siege-utils-theme';
      link.rel = 'stylesheet';
      link.href = cssUrl;
      document.head.appendChild(link);
    } else if (existingThemeLink.href !== cssUrl) {
      existingThemeLink.href = cssUrl;
    }

    if (theme === 'custom') {
      applyCustomColors(customColors);
      applyCustomHue(customHue);
    } else {
      if (existingCustomStyle) existingCustomStyle.remove();
      if (existingHueStyle) existingHueStyle.remove();
    }

    toggleHues(disableHues);
    applyModalTextureFix();
    if (theme === 'spooky') {
      queueSpookyJumpScare();
      showSpookyAudioPrompt();
    } else {
      teardownSpookyJumpScare();
    }
  } else {
    if (existingThemeLink) existingThemeLink.remove();
    if (existingCustomStyle) existingCustomStyle.remove();
    if (existingHueStyle) existingHueStyle.remove();
    document.body.classList.remove('no-hues');
    removeModalTextureFix();
    teardownSpookyJumpScare();
  }
}

function applyModalTextureFix() {
  let style = document.getElementById('siege-utils-modal-texture');
  if (!style) {
    style = document.createElement('style');
    style.id = 'siege-utils-modal-texture';
    document.head.appendChild(style);
  }

  style.textContent = `
    .siege-modal-content,
    .siege-orders-content,
    .siege-lb-content,
    .siege-reasoning-panel,
    .modal-content {
      background: var(--ctp-surface0, #313244) url('/assets/parchment-texture-e4dc566e.jpg') repeat !important;
      background-blend-mode: multiply !important;
    }
  `;
}

function removeModalTextureFix() {
  const style = document.getElementById('siege-utils-modal-texture');
  if (style) style.remove();
}

function applyCustomColors(colors) {
  let style = document.getElementById('siege-utils-custom');
  if (!style) {
    style = document.createElement('style');
    style.id = 'siege-utils-custom';
    document.head.appendChild(style);
  }

  const cssVars = Object.entries(colors).map(([key, value]) =>
    `--ctp-${key}: ${value};`
  ).join('\n  ');

  style.textContent = `:root {\n  ${cssVars}\n}`;
}

function applyCustomHue(hue) {
  let style = document.getElementById('siege-utils-custom-hue');
  if (!style) {
    style = document.createElement('style');
    style.id = 'siege-utils-custom-hue';
    document.head.appendChild(style);
  }

  const hueRotate = hue.hueRotate || 180;
  const saturate = hue.saturate || 120;
  const brightness = hue.brightness || 110;

  const filterValue = `sepia(0.5) contrast(1.15) opacity(0.95) hue-rotate(${hueRotate}deg) saturate(${saturate / 100}) brightness(${brightness / 100})`;

  style.textContent = `
    svg:not(.icon-sm):not(.icon-xs):not([class*="icon"]):not([alt*="eeple"]):not([src*="meeple"]) {
      filter: ${filterValue} !important;
    }
    .home-wave {
      filter: ${filterValue} !important;
    }
    img.siege-logo {
      filter: ${filterValue} !important;
    }
    canvas:not([id*="chart"]):not([class*="chart"]) {
      filter: ${filterValue} !important;
    }
  `;
}

function toggleHues(disable) {
  if (disable) {
    document.body.classList.add('no-hues');
  } else {
    document.body.classList.remove('no-hues');
  }
}

function getPageSpecificJumpscare() {
  const path = window.location.pathname;

  if (path.includes('/keep')) {
    return {
      emoji: ['⚰️', '💀', '🪦', '👻'][Math.floor(Math.random() * 4)],
      text: ['YOUR TIME IS UP!', 'NO ESCAPE!', 'GAME OVER!', 'TOO LATE!'][Math.floor(Math.random() * 4)],
      type: 'blood'
    };
  } else if (path.includes('/market')) {
    return {
      emoji: ['👹', '😈', '🔪', '💉'][Math.floor(Math.random() * 4)],
      text: ['SOLD YOUR SOUL!', 'THE PRICE IS BLOOD!', 'CURSED DEAL!', 'NO REFUNDS!'][Math.floor(Math.random() * 4)],
      type: 'glitch'
    };
  } else if (path.includes('/great-hall')) {
    return {
      emoji: ['👤', '🕴️', '👁️', '🦴'][Math.floor(Math.random() * 4)],
      text: ['THEY\'RE WATCHING!', 'BETRAYAL!', 'RIGGED!', 'YOU LOSE!'][Math.floor(Math.random() * 4)],
      type: 'static'
    };
  } else if (path.includes('/catacombs')) {
    return {
      emoji: ['🕷️', '🦇', '🐍', '🕸️'][Math.floor(Math.random() * 4)],
      text: ['TRAPPED FOREVER!', 'NO WAY OUT!', 'ENDLESS MAZE!', 'LOST IN DARKNESS!'][Math.floor(Math.random() * 4)],
      type: 'crawl'
    };
  } else if (path.includes('/chambers')) {
    return {
      emoji: ['🔮', '🌙', '⚡', '💫'][Math.floor(Math.random() * 4)],
      text: ['CURSED!', 'DARK MAGIC!', 'POSSESSED!', 'HAUNTED!'][Math.floor(Math.random() * 4)],
      type: 'shake'
    };
  } else {
    return {
      emoji: ['💀', '👹', '👻', '🎃', '😱', '☠️'][Math.floor(Math.random() * 6)],
      text: ['BOO!', 'GOTCHA!', 'AHHH!', 'SPOOKY!', 'WATCH OUT!', 'BEHIND YOU!'][Math.floor(Math.random() * 6)],
      type: ['blood', 'glitch', 'static', 'shake'][Math.floor(Math.random() * 4)]
    };
  }
}

function showSpookyJumpScare() {

  if (!document.body || document.getElementById('siege-spooky-jumpscare')) {
    return;
  }

  spookyJumpScareCount++;
  const scare = getPageSpecificJumpscare();

  playSpookyScream();

  const overlay = document.createElement('div');
  overlay.id = 'siege-spooky-jumpscare';
  overlay.dataset.type = scare.type;

  const inner = document.createElement('div');
  inner.className = 'siege-spooky-jumpscare-inner';

  const emoji = document.createElement('div');
  emoji.className = 'siege-spooky-jumpscare-emoji';
  emoji.textContent = scare.emoji;

  const text = document.createElement('div');
  text.className = 'siege-spooky-jumpscare-text';
  text.textContent = scare.text;

  inner.appendChild(emoji);
  inner.appendChild(text);
  overlay.appendChild(inner);

  if (scare.type === 'blood') {
    const bloodSplatter = document.createElement('div');
    bloodSplatter.className = 'siege-blood-splatter';
    overlay.appendChild(bloodSplatter);
  } else if (scare.type === 'crawl') {
    for (let i = 0; i < 8; i++) {
      const spider = document.createElement('div');
      spider.className = 'siege-spider';
      spider.style.left = `${Math.random() * 100}%`;
      spider.style.animationDelay = `${Math.random() * 0.5}s`;
      spider.textContent = '🕷️';
      overlay.appendChild(spider);
    }
  }

  document.body.appendChild(overlay);

  requestAnimationFrame(() => {
    overlay.classList.add('is-visible');
  });

  window.setTimeout(() => {
    overlay.classList.add('is-fading');
  }, 2500);

  window.setTimeout(() => {
    overlay.remove();
  }, 3300);
}

function queueSpookyJumpScare() {
  if (typeof window === 'undefined') {
    return;
  }


  if (spookyJumpScareCount >= MAX_SPOOKY_JUMPSCARES || spookyJumpScareTimeout || document.getElementById('siege-spooky-jumpscare')) {
    return;
  }

  const delay = 3000 + Math.random() * 7000;
  spookyJumpScareTimeout = window.setTimeout(() => {
    spookyJumpScareTimeout = null;
    showSpookyJumpScare();

    if (spookyJumpScareCount < MAX_SPOOKY_JUMPSCARES && Math.random() > 0.3) {
      const nextDelay = 10000 + Math.random() * 20000;
      window.setTimeout(() => queueSpookyJumpScare(), nextDelay);
    }
  }, delay);
}

function teardownSpookyJumpScare() {
  if (spookyJumpScareTimeout) {
    window.clearTimeout(spookyJumpScareTimeout);
    spookyJumpScareTimeout = null;
  }

  const overlay = document.getElementById('siege-spooky-jumpscare');
  if (overlay) {
    overlay.remove();
  }

  hasShownSpookyJumpScare = false;
  spookyJumpScareCount = 0;

  if (spookyBackgroundAudio) {
    spookyBackgroundAudio.stop();
    spookyBackgroundAudio = null;
  }

  spookyAudioUnlocked = false;
}

function createSpookyAudioContext() {
  if (!window.AudioContext && !window.webkitAudioContext) {
    return null;
  }
  return new (window.AudioContext || window.webkitAudioContext)();
}

function playSpookyScream() {
  if (!spookyAudioUnlocked) return;

  const audioContext = createSpookyAudioContext();
  if (!audioContext) return;

  const oscillator = audioContext.createOscillator();
  const gainNode = audioContext.createGain();
  const filter = audioContext.createBiquadFilter();

  oscillator.connect(filter);
  filter.connect(gainNode);
  gainNode.connect(audioContext.destination);

  oscillator.type = 'sawtooth';
  oscillator.frequency.setValueAtTime(880, audioContext.currentTime);
  oscillator.frequency.exponentialRampToValueAtTime(110, audioContext.currentTime + 0.3);

  filter.type = 'lowpass';
  filter.frequency.setValueAtTime(2000, audioContext.currentTime);
  filter.frequency.exponentialRampToValueAtTime(500, audioContext.currentTime + 0.3);

  gainNode.gain.setValueAtTime(0.8, audioContext.currentTime);
  gainNode.gain.exponentialRampToValueAtTime(0.01, audioContext.currentTime + 0.8);

  oscillator.start(audioContext.currentTime);
  oscillator.stop(audioContext.currentTime + 0.8);
}

function startSpookyBackgroundAudio() {
  if (!spookyAudioUnlocked || spookyBackgroundAudio) return;

  const audioContext = createSpookyAudioContext();
  if (!audioContext) return;

  const playAmbientDrone = () => {
    const oscillator1 = audioContext.createOscillator();
    const oscillator2 = audioContext.createOscillator();
    const gainNode = audioContext.createGain();
    const filter = audioContext.createBiquadFilter();

    oscillator1.type = 'sine';
    oscillator1.frequency.setValueAtTime(55, audioContext.currentTime);

    oscillator2.type = 'triangle';
    oscillator2.frequency.setValueAtTime(82.5, audioContext.currentTime);

    oscillator1.connect(filter);
    oscillator2.connect(filter);
    filter.connect(gainNode);
    gainNode.connect(audioContext.destination);

    filter.type = 'lowpass';
    filter.frequency.setValueAtTime(200, audioContext.currentTime);
    filter.Q.setValueAtTime(10, audioContext.currentTime);

    gainNode.gain.setValueAtTime(0, audioContext.currentTime);
    gainNode.gain.linearRampToValueAtTime(0.15, audioContext.currentTime + 2);

    oscillator1.start(audioContext.currentTime);
    oscillator2.start(audioContext.currentTime);

    window.setTimeout(() => {
      gainNode.gain.linearRampToValueAtTime(0, audioContext.currentTime + 2);
      window.setTimeout(() => {
        oscillator1.stop();
        oscillator2.stop();
      }, 2000);
    }, 8000);
  };

  playAmbientDrone();
  const interval = window.setInterval(() => {
    if (!spookyAudioUnlocked) {
      window.clearInterval(interval);
      return;
    }
    playAmbientDrone();
  }, 10000);

  spookyBackgroundAudio = { stop: () => window.clearInterval(interval) };
}

function showSpookyAudioPrompt() {
  if (spookyAudioUnlocked || document.getElementById('siege-spooky-audio-prompt')) {
    return;
  }

  const backdrop = document.createElement('div');
  backdrop.id = 'siege-spooky-audio-backdrop';

  const prompt = document.createElement('div');
  prompt.id = 'siege-spooky-audio-prompt';
  prompt.innerHTML = `
    <div class="spooky-prompt-title">⚠️ WARNING ⚠️</div>
    <div class="spooky-prompt-text">
      You have entered the haunted realm...<br>
      The spirits demand your attention.
    </div>
    <button class="spooky-prompt-button">PRESS THIS OR ELSE</button>
    <div class="spooky-prompt-warning">
      (Click to unlock the full horror experience)
    </div>
  `;

  document.body.appendChild(backdrop);
  document.body.appendChild(prompt);

  const button = prompt.querySelector('.spooky-prompt-button');
  button.addEventListener('click', () => {
    spookyAudioUnlocked = true;

    prompt.style.animation = 'spooky-prompt-appear 0.3s ease-out reverse';
    backdrop.style.animation = 'spooky-prompt-appear 0.3s ease-out reverse';

    window.setTimeout(() => {
      prompt.remove();
      backdrop.remove();

      startSpookyBackgroundAudio();
      playSpookyScream();
    }, 300);
  });
}

browserAPI.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'THEME_CHANGE') {
    applyTheme(message.theme, message.disableHues, message.customColors, message.customHue);
  } else if (message.type === 'TOGGLE_HUES') {
    toggleHues(message.disableHues);
  } else if (message.type === 'UPDATE_CUSTOM_COLORS') {
    applyCustomColors(message.customColors);
  } else if (message.type === 'UPDATE_CUSTOM_HUE') {
    applyCustomHue(message.customHue);
  }
});

browserAPI.storage.sync.get(['theme', 'disableHues', 'customColors', 'customHue'], (result) => {
  const theme = result.theme || 'classic';
  const disableHues = result.disableHues || false;
  const customColors = result.customColors || {};
  const customHue = result.customHue || {};
  applyTheme(theme, disableHues, customColors, customHue);
});

let hasInitializedVoting = false;

function initSimpleVotingInterface() {
  if (!window.location.pathname.includes('great-hall')) {
    return;
  }

  if (hasInitializedVoting) {
    return;
  }


  function extractVotingData() {
    const scripts = document.querySelectorAll('script');
    let votesData = null;
    let ballotId = null;

    const assignBallotId = (candidate) => {
      if (ballotId !== null && ballotId !== undefined) {
        return;
      }
      if (candidate === null || candidate === undefined) {
        return;
      }
      const raw = String(candidate).trim().replace(/^['"`]/, '').replace(/['"`]$/, '');
      if (!raw) {
        return;
      }
      ballotId = /^\d+$/.test(raw) ? parseInt(raw, 10) : raw;
    };

    for (const script of scripts) {
      const content = script.textContent;
      if (!content) {
        continue;
      }

      if (!votesData && (content.includes('const votes =') || content.includes('votingManager.votes ='))) {

        const votesMatch = content.match(/(?:const votes|votingManager\.votes)\s*=\s*(\[[\s\S]*?\]);/);
        if (votesMatch) {
          try {
            votesData = JSON.parse(votesMatch[1]);
          } catch (e) {
            console.error('[Siege Utils] Failed to parse votes data:', e);
          }
        }
      }

      if (ballotId === null || ballotId === undefined) {
        const scriptMatch = content.match(/currentBallot(?:Id|ID|UUID|Uuid)\s*=\s*(?:['"`])?([A-Za-z0-9_-]+)/);
        if (scriptMatch) {
          assignBallotId(scriptMatch[1]);
        }
      }

      if (ballotId === null || ballotId === undefined) {
        const jsonMatch = content.match(/"ballot_id"\s*:\s*(\d+)/);
        if (jsonMatch) {
          assignBallotId(jsonMatch[1]);
        }
      }

      if (ballotId === null || ballotId === undefined) {
        const uuidMatch = content.match(/ballot(?:Id|ID|UUID|Uuid)\s*:\s*(?:['"`])([A-Za-z0-9_-]+)(?:['"`])/);
        if (uuidMatch) {
          assignBallotId(uuidMatch[1]);
        }
      }
    }

    if (ballotId === null || ballotId === undefined) {
      const metaBallot = document.querySelector('meta[name="current-ballot-id"]');
      if (metaBallot && metaBallot.content) {
        assignBallotId(metaBallot.content);
      }
    }

    if (ballotId === null || ballotId === undefined) {
      const ballotElement = document.querySelector('[data-ballot-id]');
      if (ballotElement) {
        assignBallotId(ballotElement.dataset?.ballotId || ballotElement.getAttribute('data-ballot-id'));
      }
    }

    if (ballotId === null || ballotId === undefined) {
      const urlMatch = window.location.pathname.match(/\/great-hall\/([A-Za-z0-9_-]+)/);
      if (urlMatch) {
        assignBallotId(urlMatch[1]);
      }
    }

    if ((ballotId === null || ballotId === undefined) && votesData && votesData.length > 0) {
      for (const vote of votesData) {
        if (!vote) {
          continue;
        }
        assignBallotId(
          vote.ballot_id ??
          vote.ballotId ??
          (vote.ballot && (vote.ballot.id ?? vote.ballot.uuid)) ??
          (vote.meta && vote.meta.ballot_id)
        );
        if (ballotId !== null && ballotId !== undefined) {
          break;
        }
      }
    }

    return { votes: votesData, ballotId };
  }

  let { votes: votesData, ballotId } = extractVotingData();

  if (votesData) {
    if (!votesData || votesData.length === 0) {
      hasInitializedVoting = true;
      showVotingFinishedMessage();
      return;
    }

    hasInitializedVoting = true;
    createVotingInterface(votesData, ballotId);
  } else {
    let attempts = 0;
    const checkInterval = setInterval(() => {
      if (hasInitializedVoting) {
        clearInterval(checkInterval);
        return;
      }

      attempts++;

      if (attempts > 30) {
        clearInterval(checkInterval);
        hasInitializedVoting = true;
        showVotingFinishedMessage();
        return;
      }

      const result = extractVotingData();
      votesData = result.votes;
      ballotId = result.ballotId;

      if (votesData) {
        clearInterval(checkInterval);

        if (!votesData || votesData.length === 0) {
          hasInitializedVoting = true;
          showVotingFinishedMessage();
          return;
        }

        hasInitializedVoting = true;
        createVotingInterface(votesData, ballotId);
      }
    }, 200);
  }
}

function showVotingFinishedMessage() {

  const canvas = document.getElementById('voting-canvas');
  if (canvas) {
    canvas.style.display = 'none';
  }

  const uiOverlay = document.querySelector('.ui-overlay');
  if (uiOverlay) {
    uiOverlay.style.display = 'none';
  }

  const greatHall = document.querySelector('.great-hall');
  if (greatHall) {
    greatHall.style.display = 'none';
  }

  const dialogueBox = document.querySelector('.dialogue-box');
  if (dialogueBox) {
    dialogueBox.style.display = 'none';
  }

  const votingPanel = document.querySelector('.voting-panel');
  if (votingPanel) {
    votingPanel.style.display = 'none';
  }

  const reasoningPanel = document.querySelector('.reasoning-panel');
  if (reasoningPanel) {
    reasoningPanel.style.display = 'none';
  }

  const presentingMeeple = document.querySelector('.presenting-meeple');
  if (presentingMeeple) {
    presentingMeeple.style.display = 'none';
  }

  const userMeeple = document.querySelector('.user-meeple-container');
  if (userMeeple) {
    userMeeple.style.display = 'none';
  }

  const appMain = document.querySelector('.app-main');
  if (!appMain) {
    return;
  }

  appMain.innerHTML = '';

  const messageContainer = document.createElement('div');
  messageContainer.style.cssText = `
    padding: 2rem;
    padding-left: 22rem;
    max-width: 1200px;
    margin: 0 auto;
    min-height: 100vh;
    display: flex;
    align-items: center;
    justify-content: center;
  `;

  messageContainer.innerHTML = `
    <div style="
      background: #f5f5f4 url('/assets/parchment-texture-e4dc566e.jpg') repeat;
      border: 3px solid rgba(64, 43, 32, 0.75);
      border-radius: 8px;
      padding: 3rem;
      box-shadow: 0 4px 12px rgba(0,0,0,0.2);
      text-align: center;
      max-width: 600px;
    ">
      <h1 style="
        font-size: 2.5rem;
        color: #3b2a1a;
        margin: 0 0 1rem 0;
        font-family: 'Jaini', 'IM Fell English', serif;
      ">You finished voting</h1>
      <p style="
        font-size: 1.25rem;
        color: #6b5437;
        margin: 0 0 2rem 0;
        line-height: 1.6;
      ">Voting for this week has concluded. Check back next week to vote on new projects!</p>
      <button id="siege-vote-again-btn" style="
        background: #3b2a1a;
        color: #f5f5f4;
        border: 2px solid rgba(64, 43, 32, 0.75);
        padding: 0.75rem 2rem;
        font-size: 1.1rem;
        font-family: 'IM Fell English', serif;
        border-radius: 6px;
        cursor: pointer;
        transition: all 0.2s ease;
      " onmouseover="this.style.background='#5a3f2a'" onmouseout="this.style.background='#3b2a1a'">
        Vote Again
      </button>
    </div>
  `;

  appMain.appendChild(messageContainer);

  const voteAgainBtn = document.getElementById('siege-vote-again-btn');
  if (voteAgainBtn) {
    voteAgainBtn.addEventListener('click', () => {
      voteAgainBtn.disabled = true;
      voteAgainBtn.textContent = 'Creating ballot...';
      voteAgainBtn.style.cursor = 'not-allowed';
      window.location.href = '/great-hall?create_new=true';
    });
  }
}

const githubAPI = {
  async fetchRepoData(repoUrl) {
    if (!repoUrl || !repoUrl.includes('github.com')) {
      return null;
    }

    try {
      const match = repoUrl.match(/github\.com\/([^\/]+)\/([^\/\?#]+)/);
      if (!match) return null;

      const [, owner, repo] = match;
      const cleanRepo = repo.replace(/\.git$/, '');

      const [repoData, readmeData, languagesData, commitsData, contentsData] = await Promise.all([
        fetch(`https://api.github.com/repos/${owner}/${cleanRepo}`).then(r => r.ok ? r.json() : null),
        fetch(`https://api.github.com/repos/${owner}/${cleanRepo}/readme`).then(r => r.ok ? r.json() : null),
        fetch(`https://api.github.com/repos/${owner}/${cleanRepo}/languages`).then(r => r.ok ? r.json() : null),
        fetch(`https://api.github.com/repos/${owner}/${cleanRepo}/commits?per_page=1`).then(r => r.ok ? r.headers.get('Link') : null),
        fetch(`https://api.codetabs.com/v1/loc?github=${owner}/${cleanRepo}`).then(r => r.ok ? r.json() : null).catch(() => null)
      ]);

      let readmePreview = '';
      if (readmeData && readmeData.content) {
        const decoded = atob(readmeData.content);
        const lines = decoded.split('\n').slice(0, 15);
        readmePreview = lines.join('\n');
      }

      let topLanguage = '';
      let languagePercentages = [];
      let totalBytes = 0;
      if (languagesData) {
        totalBytes = Object.values(languagesData).reduce((sum, val) => sum + val, 0);
        languagePercentages = Object.entries(languagesData)
          .map(([lang, bytes]) => ({ lang, percentage: ((bytes / totalBytes) * 100).toFixed(1), bytes }))
          .sort((a, b) => parseFloat(b.percentage) - parseFloat(a.percentage));
        topLanguage = languagePercentages[0]?.lang || '';
      }

      let commitCount = 0;
      if (commitsData) {
        const linkMatch = commitsData.match(/page=(\d+)>; rel="last"/);
        commitCount = linkMatch ? parseInt(linkMatch[1]) : 1;
      }

      let linesOfCode = 0;
      if (contentsData && Array.isArray(contentsData)) {
        linesOfCode = contentsData.reduce((total, lang) => {
          return total + (lang.linesOfCode || 0);
        }, 0);
      }

      if (linesOfCode === 0 && totalBytes > 0) {
        linesOfCode = Math.round(totalBytes / 40);
      }

      const updatedAt = repoData?.updated_at ? new Date(repoData.updated_at) : null;
      const daysAgo = updatedAt ? Math.floor((Date.now() - updatedAt.getTime()) / (1000 * 60 * 60 * 24)) : null;

      return {
        topLanguage,
        languagePercentages: languagePercentages.slice(0, 3),
        linesOfCode,
        commitCount,
        daysAgo,
        readmePreview,
        fullReadme: readmeData ? atob(readmeData.content) : ''
      };
    } catch (error) {
      console.error('Error fetching GitHub data:', error);
      return null;
    }
  }
};

function createVotingInterface(votes, ballotId) {

  const canvas = document.getElementById('voting-canvas');
  if (canvas) {
    canvas.style.display = 'none';
  }

  const uiOverlay = document.querySelector('.ui-overlay');
  if (uiOverlay) {
    uiOverlay.style.display = 'none';
  }

  const greatHall = document.querySelector('.great-hall');
  if (greatHall) {
    greatHall.style.display = 'none';
  }

  const dialogueBox = document.querySelector('.dialogue-box');
  if (dialogueBox) {
    dialogueBox.style.display = 'none';
  }

  const votingPanel = document.querySelector('.voting-panel');
  if (votingPanel) {
    votingPanel.style.display = 'none';
  }

  const reasoningPanel = document.querySelector('.reasoning-panel');
  if (reasoningPanel) {
    reasoningPanel.style.display = 'none';
  }

  const presentingMeeple = document.querySelector('.presenting-meeple');
  if (presentingMeeple) {
    presentingMeeple.style.display = 'none';
  }

  const userMeeple = document.querySelector('.user-meeple-container');
  if (userMeeple) {
    userMeeple.style.display = 'none';
  }

  const appMain = document.querySelector('.app-main');
  if (!appMain) {
    return;
  }

  appMain.innerHTML = '';

  const votingContainer = document.createElement('div');
  votingContainer.id = 'siege-simple-voting';

  const starAllocations = {};
  votes.forEach(vote => {
    starAllocations[vote.id] = vote.star_count || 1;
  });

  let totalStars = Object.values(starAllocations).reduce((sum, stars) => sum + stars, 0);

  votingContainer.innerHTML = `
      <div class="siege-voting-header">
        <h1>Vote on Week ${votes[0]?.week || ''} Projects</h1>
        <div class="siege-voting-stars-total">
          Total Stars: <span id="siege-total-stars">${totalStars}</span> / 12
        </div>
      </div>

      <div class="siege-voting-layout">
        <div class="siege-projects-list" id="siege-projects-list"></div>

        <div class="siege-reasoning-panel">
          <h3 class="siege-reasoning-title">Your Reasoning</h3>
          <textarea
            class="siege-reasoning-textarea"
            id="siege-reasoning"
            placeholder="Share your thoughts on the projects and why you voted the way you did..."
          ></textarea>
          <button class="siege-submit-btn" id="siege-submit-vote" disabled>
            Submit Votes
          </button>
          <div class="siege-error-msg" id="siege-error-msg"></div>
        </div>
      </div>
    `;

  appMain.appendChild(votingContainer);

  const projectsList = document.getElementById('siege-projects-list');
  votes.forEach(async (vote) => {
    if (!vote.project) return;

    const projectCard = document.createElement('div');
    projectCard.className = 'siege-project-card';
    projectCard.innerHTML = `
        <div class="siege-project-header">
          <div>
            <h2 class="siege-project-title">${vote.project.name}</h2>
            <p class="siege-project-author">by ${vote.project.user?.name || 'Unknown'}</p>
          </div>
        </div>

        <p class="siege-project-description">${vote.project.description || ''}</p>

        <div class="siege-github-stats" id="github-stats-${vote.id}">
          <div class="siege-github-loading">Loading GitHub data...</div>
        </div>

        <div class="siege-readme-section" id="readme-${vote.id}" style="display: none;">
          <button class="siege-readme-toggle" data-vote-id="${vote.id}">
            <span class="siege-toggle-icon">▼</span> Show README Preview
          </button>
          <div class="siege-readme-content" style="display: none;"></div>
        </div>

        <div class="siege-project-links">
          ${vote.project.repo_url ? `<a href="${vote.project.repo_url}" target="_blank" class="siege-project-link">View Code</a>` : ''}
          ${vote.project.demo_url ? `
            <div class="siege-demo-link-wrapper">
              <a href="${vote.project.demo_url}" target="_blank" class="siege-project-link siege-demo-link" data-demo-url="${vote.project.demo_url}">Play Project</a>
              <div class="siege-demo-preview" id="demo-preview-${vote.id}" style="display: none;">
                <iframe src="${vote.project.demo_url}" frameborder="0" sandbox="allow-scripts allow-same-origin"></iframe>
                <div class="siege-demo-preview-label">Preview</div>
              </div>
            </div>
          ` : ''}
        </div>

        <div class="siege-star-control">
          <span class="siege-star-label">Stars:</span>
          <button class="siege-star-btn" data-vote-id="${vote.id}" data-action="decrease">−</button>
          <div class="siege-star-display" id="stars-${vote.id}"></div>
          <button class="siege-star-btn" data-vote-id="${vote.id}" data-action="increase">+</button>
        </div>
      `;

    projectsList.appendChild(projectCard);

    renderStars(vote.id, starAllocations[vote.id]);

    if (vote.project.repo_url) {
      const githubData = await githubAPI.fetchRepoData(vote.project.repo_url);
      const statsContainer = document.getElementById(`github-stats-${vote.id}`);
      const readmeSection = document.getElementById(`readme-${vote.id}`);

      if (githubData && statsContainer) {
        const languagesHTML = githubData.languagePercentages.map(l =>
          `<span class="siege-lang-tag">${l.lang} ${l.percentage}%</span>`
        ).join('');

        statsContainer.innerHTML = `
            <div class="siege-github-info">
              ${githubData.topLanguage ? `<div class="siege-stat-item"><span class="siege-stat-icon">💻</span> ${githubData.topLanguage}</div>` : ''}
              ${githubData.linesOfCode > 0 ? `<div class="siege-stat-item"><span class="siege-stat-icon">📝</span> ~${githubData.linesOfCode.toLocaleString()} lines</div>` : ''}
              ${githubData.commitCount > 0 ? `<div class="siege-stat-item"><span class="siege-stat-icon">📊</span> ${githubData.commitCount} commits</div>` : ''}
              ${githubData.daysAgo !== null ? `<div class="siege-stat-item"><span class="siege-stat-icon">🕐</span> Updated ${githubData.daysAgo === 0 ? 'today' : githubData.daysAgo === 1 ? 'yesterday' : `${githubData.daysAgo}d ago`}</div>` : ''}
            </div>
            ${languagesHTML ? `<div class="siege-languages">${languagesHTML}</div>` : ''}
          `;

        if (githubData.readmePreview && readmeSection) {
          readmeSection.style.display = 'block';
          const readmeContent = readmeSection.querySelector('.siege-readme-content');
          if (readmeContent) {
            readmeContent.textContent = githubData.readmePreview;
          }
        }
      } else if (statsContainer) {
        statsContainer.innerHTML = '';
      }
    }
  });

  function renderStars(voteId, count) {
    const starDisplay = document.getElementById(`stars-${voteId}`);
    if (!starDisplay) return;

    starDisplay.innerHTML = '';
    for (let i = 0; i < 5; i++) {
      const star = document.createElement('span');
      star.className = `siege-star-icon ${i < count ? '' : 'empty'}`;
      star.textContent = '★';
      starDisplay.appendChild(star);
    }
  }

  function updateButtons() {
    document.querySelectorAll('.siege-star-btn').forEach(btn => {
      const voteId = parseInt(btn.dataset.voteId);
      const action = btn.dataset.action;
      const currentStars = starAllocations[voteId];

      if (action === 'decrease') {
        btn.disabled = currentStars <= 1;
      } else if (action === 'increase') {
        btn.disabled = currentStars >= 5 || totalStars >= 12;
      }
    });

    document.getElementById('siege-total-stars').textContent = totalStars;

    const reasoning = document.getElementById('siege-reasoning').value.trim();
    const submitBtn = document.getElementById('siege-submit-vote');
    submitBtn.disabled = totalStars !== 12 || !reasoning;

    const errorMsg = document.getElementById('siege-error-msg');
    if (totalStars !== 12) {
      errorMsg.textContent = `You must allocate exactly 12 stars (currently ${totalStars})`;
    } else if (!reasoning) {
      errorMsg.textContent = 'Please provide reasoning for your votes';
    } else {
      errorMsg.textContent = '';
    }
  }

  projectsList.addEventListener('click', async (e) => {
    const readmeToggle = e.target.closest('.siege-readme-toggle');
    if (readmeToggle) {
      const voteId = readmeToggle.dataset.voteId;
      const readmeContent = document.querySelector(`#readme-${voteId} .siege-readme-content`);
      const toggleIcon = readmeToggle.querySelector('.siege-toggle-icon');

      if (readmeContent) {
        const isHidden = readmeContent.style.display === 'none';
        readmeContent.style.display = isHidden ? 'block' : 'none';
        toggleIcon.textContent = isHidden ? '▲' : '▼';
        readmeToggle.childNodes[1].textContent = isHidden ? ' Hide README Preview' : ' Show README Preview';
      }
      return;
    }

    if (!e.target.classList.contains('siege-star-btn')) return;

    const voteId = parseInt(e.target.dataset.voteId);
    const action = e.target.dataset.action;
    const currentStars = starAllocations[voteId];

    let newStars = currentStars;
    if (action === 'decrease' && currentStars > 1) {
      newStars = currentStars - 1;
      totalStars--;
    } else if (action === 'increase' && currentStars < 5 && totalStars < 12) {
      newStars = currentStars + 1;
      totalStars++;
    }

    if (newStars !== currentStars) {
      starAllocations[voteId] = newStars;
      renderStars(voteId, newStars);
      updateButtons();

      try {
        const response = await fetch(`/votes/${voteId}/update_stars`, {
          method: 'PATCH',
          headers: {
            'Content-Type': 'application/json',
            'X-CSRF-Token': document.querySelector('meta[name="csrf-token"]').content
          },
          body: JSON.stringify({ star_count: newStars })
        });

        if (!response.ok) {
          console.error('Failed to update stars');
          if (action === 'decrease') {
            starAllocations[voteId]++;
            totalStars++;
          } else {
            starAllocations[voteId]--;
            totalStars--;
          }
          renderStars(voteId, starAllocations[voteId]);
          updateButtons();
        }
      } catch (error) {
        console.error('Error updating stars:', error);
      }
    }
  });

  projectsList.addEventListener('mouseover', (e) => {
    const demoLink = e.target.closest('.siege-demo-link');
    if (demoLink) {
      const wrapper = demoLink.closest('.siege-demo-link-wrapper');
      const preview = wrapper?.querySelector('.siege-demo-preview');
      if (preview) {
        preview.style.display = 'block';
      }
    }
  });

  projectsList.addEventListener('mouseout', (e) => {
    const demoLink = e.target.closest('.siege-demo-link');
    if (demoLink) {
      const wrapper = demoLink.closest('.siege-demo-link-wrapper');
      const preview = wrapper?.querySelector('.siege-demo-preview');
      if (preview) {
        preview.style.display = 'none';
      }
    }
  });

  document.getElementById('siege-reasoning').addEventListener('input', updateButtons);

  document.getElementById('siege-submit-vote').addEventListener('click', async () => {
    const reasoning = document.getElementById('siege-reasoning').value.trim();
    const submitBtn = document.getElementById('siege-submit-vote');

    if (totalStars !== 12 || !reasoning) return;

    submitBtn.disabled = true;
    submitBtn.textContent = 'Submitting...';

    try {
      if (!ballotId) {
        console.error('[Siege Utils] Could not find ballot ID');
        alert('Error: Could not find ballot ID');
        submitBtn.disabled = false;
        submitBtn.textContent = 'Submit Votes';
        return;
      }

      const response = await fetch(`/ballots/${ballotId}/submit`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          'X-CSRF-Token': document.querySelector('meta[name="csrf-token"]').content
        },
        body: JSON.stringify({ reasoning: reasoning })
      });

      const data = await response.json();

      if (data.success) {
        window.location.href = data.redirect_url || '/great-hall';
      } else {
        alert('Error submitting ballot: ' + (data.errors || 'Unknown error'));
        submitBtn.disabled = false;
        submitBtn.textContent = 'Submit Votes';
      }
    } catch (error) {
      console.error('Error submitting ballot:', error);
      alert('Error submitting ballot. Please try again.');
      submitBtn.disabled = false;
      submitBtn.textContent = 'Submit Votes';
    }
  });

  updateButtons();
}

document.addEventListener('turbo:load', initSimpleVotingInterface);
document.addEventListener('turbo:render', initSimpleVotingInterface);

document.addEventListener('turbo:before-visit', () => {
  hasInitializedVoting = false;
});

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initSimpleVotingInterface);
} else {
  initSimpleVotingInterface();
}

const bettingAPI = {
  cache: {},
  CACHE_DURATION: 2 * 60 * 1000,

  async fetchWithCache(url, cacheKey) {
    const now = Date.now();
    if (this.cache[cacheKey] && (now - this.cache[cacheKey].timestamp) < this.CACHE_DURATION) {
      return this.cache[cacheKey].data;
    }

    try {
      const response = await fetch(url);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const data = await response.json();

      this.cache[cacheKey] = { data, timestamp: now };
      return data;
    } catch (error) {
      console.error(`[BettingAPI] Failed to fetch ${url}:`, error);
      return null;
    }
  },

  async getAllProjects() {
    return this.fetchWithCache('https://siege.hackclub.com/api/public-beta/projects', 'projects');
  },

  async getUserData(userId) {
    return this.fetchWithCache(
      `https://siege.hackclub.com/api/public-beta/user/${userId}`,
      `user_${userId}`
    );
  },

  async getLeaderboard() {
    return this.fetchWithCache('https://siege.hackclub.com/api/public-beta/leaderboard', 'leaderboard');
  },

  async getShop() {
    return this.fetchWithCache('https://siege.hackclub.com/api/public-beta/shop', 'shop');
  },

  getCurrentUserId() {
    const userMeta = document.querySelector('[data-user-id]');
    return userMeta ? userMeta.dataset.userId : null;
  },

  calculateWeeklyStats(projectsData) {
    if (!projectsData || !projectsData.projects) return new Map();

    const weeklyStats = new Map();

    projectsData.projects.forEach(project => {
      const weekMatch = project.week_badge_text?.match(/Week (\d+)/);
      if (!weekMatch) return;

      const weekNum = parseInt(weekMatch[1]);
      if (!weeklyStats.has(weekNum)) {
        weeklyStats.set(weekNum, { totalHours: 0, projectCount: 0 });
      }

      const stats = weeklyStats.get(weekNum);
      stats.totalHours += project.hours || 0;
      stats.projectCount += 1;
    });

    return weeklyStats;
  },

  getCurrentWeek(projectsData) {
    if (!projectsData || !projectsData.projects || projectsData.projects.length === 0) return 9;

    const weeks = projectsData.projects
      .map(p => {
        const match = p.week_badge_text?.match(/Week (\d+)/);
        return match ? parseInt(match[1]) : 0;
      })
      .filter(w => w > 0);

    return weeks.length > 0 ? Math.max(...weeks) : 9;
  },

  getUserWeeklyHours(userData) {
    if (!userData || !userData.projects) return [];

    const weeklyHours = new Map();

    userData.projects.forEach(project => {
      const weekMatch = project.week_badge_text?.match(/Week (\d+)/);
      if (!weekMatch) return;

      const weekNum = parseInt(weekMatch[1]);
      weeklyHours.set(weekNum, 0);
    });

    return Array.from(weeklyHours.values());
  }
};

const bettingSimulator = {
  calculateMultiplier(goalHours, predictedHours) {
    if (predictedHours === 0) return 1.5;

    const ratio = goalHours / predictedHours;

    if (ratio < 0.8) return 1.0;
    if (ratio < 1.0) return 1.5;
    if (ratio < 1.2) return 2.0;
    if (ratio < 1.5) return 2.5;
    return 3.0;
  },

  simulatePersonalBet(betAmount, goalHours, userWeeklyHours) {
    if (betAmount <= 0 || goalHours <= 0) {
      return { success: false, message: 'Invalid bet amount or goal hours' };
    }

    const prediction = bettingPredictor.predictPersonalHours(userWeeklyHours);
    const winProb = bettingPredictor.calculateWinProbability(goalHours, prediction);
    const multiplier = this.calculateMultiplier(goalHours, prediction.prediction);

    const potentialWin = Math.floor(betAmount * multiplier);
    const expectedValue = Math.round((potentialWin * winProb) - (betAmount * (1 - winProb)));
    const roi = ((expectedValue / betAmount) * 100).toFixed(1);

    let riskLevel, riskColor;
    if (winProb > 0.7) {
      riskLevel = 'LOW';
      riskColor = '#059669';
    } else if (winProb > 0.5) {
      riskLevel = 'MEDIUM';
      riskColor = '#d97706';
    } else {
      riskLevel = 'HIGH';
      riskColor = '#dc2626';
    }

    let recommendation;
    if (expectedValue > 0 && winProb > 0.6) {
      recommendation = '✅ Good bet! Positive expected value with decent win probability.';
    } else if (expectedValue > 0) {
      recommendation = '⚠️ Risky but profitable. Only bet what you can afford to lose.';
    } else {
      recommendation = '❌ Not recommended. Negative expected value means long-term losses.';
    }

    return {
      success: true,
      winProbability: (winProb * 100).toFixed(1),
      multiplier: multiplier.toFixed(2),
      potentialWin,
      expectedValue,
      roi,
      riskLevel,
      riskColor,
      recommendation
    };
  },

  calculateOptimalBetSize(winProb, multiplier, bankroll) {
    if (winProb <= 0 || multiplier <= 1 || bankroll <= 0) return 0;

    const b = multiplier - 1;
    const p = winProb;
    const q = 1 - p;
    const kelly = (b * p - q) / b;

    const fractionalKelly = Math.max(0, kelly * 0.25);

    return Math.floor(bankroll * fractionalKelly);
  }
};

const leaderboardRanking = {
  CACHE_DURATION: 36 * 60 * 60 * 1000,
  CACHE_KEY: 'siege_leaderboard_cache',

  async getCurrentUserRank() {
    const now = Date.now();
    const cachedData = localStorage.getItem(this.CACHE_KEY);

    if (cachedData) {
      try {
        const { data, timestamp } = JSON.parse(cachedData);
        if ((now - timestamp) < this.CACHE_DURATION) {
          return data;
        }
      } catch (e) {
        console.error('[Leaderboard] Cache parse error:', e);
      }
    }

    const userNameElement = document.querySelector('.navbar .user-name');
    if (!userNameElement) return null;

    const currentUserName = userNameElement.textContent.trim();
    const currentWeek = utils.getCurrentWeek();

    try {
      const response = await new Promise((resolve) => {
        const isFirefox = typeof browser !== 'undefined';
        const browserAPI = isFirefox ? browser : chrome;

        browserAPI.runtime.sendMessage({
          action: 'fetchLeaderboard',
          currentWeek: currentWeek,
          userName: currentUserName
        }, (response) => {
          resolve(response);
        });
      });

      if (response && response.success) {
        localStorage.setItem(this.CACHE_KEY, JSON.stringify({
          data: response.data,
          timestamp: now
        }));
        return response.data;
      } else {
        console.error('[Leaderboard] Failed:', response?.error);
        return null;
      }
    } catch (error) {
      console.error('[Leaderboard] Error:', error);
      return null;
    }
  },

  async displayRankInNavbar() {
    const userNameElement = document.querySelector('.navbar .user-name');
    if (!userNameElement) return;

    const existingRank = document.querySelector('.siege-user-rank');
    if (existingRank) existingRank.remove();

    const rankData = await this.getCurrentUserRank();
    if (!rankData) return;

    const rankElement = document.createElement('div');
    rankElement.className = 'siege-user-rank';
    rankElement.innerHTML = `
      <div class="siege-rank-container" style="
        display: flex;
        align-items: center;
        gap: 0.5rem;
        margin-top: 0.35rem;
        font-size: 0.875rem;
      ">
        <span class="siege-rank-badge" style="
          padding: 0.25rem 0.6rem;
          border-radius: 0.375rem;
          font-weight: 700;
          font-size: 0.8rem;
          cursor: pointer;
          transition: all 0.2s ease;
        ">
          #${rankData.rank}/ ${rankData.totalUsers}
        </span>
      </div>
    `;

    userNameElement.parentElement.appendChild(rankElement);

    const badge = rankElement.querySelector('.siege-rank-badge');
    badge.addEventListener('click', () => {
      leaderboardModal.open(rankData);
    });
  }
};

const leaderboardModal = {
  isOpen: false,
  leaderboardData: null,
  filteredData: null,

  open(rankData) {
    if (this.isOpen) return;

    this.leaderboardData = rankData.fullLeaderboard || [];
    this.filteredData = [...this.leaderboardData];
    this.render();
    this.isOpen = true;
  },

  close() {
    const modal = document.querySelector('#siege-leaderboard-modal');
    if (modal) {
      modal.remove();
    }
    this.isOpen = false;
    this.leaderboardData = null;
    this.filteredData = null;
  },

  filter(searchTerm) {
    if (!searchTerm || searchTerm.trim() === '') {
      this.filteredData = [...this.leaderboardData];
    } else {
      const term = searchTerm.toLowerCase();
      this.filteredData = this.leaderboardData.filter(user =>
        (user.display_name && user.display_name.toLowerCase().includes(term)) ||
        (user.name && user.name.toLowerCase().includes(term))
      );
    }
    this.updateList();
  },

  updateList() {
    const listContainer = document.querySelector('.siege-leaderboard-list');
    if (!listContainer) return;

    if (this.filteredData.length === 0) {
      listContainer.innerHTML = `
        <div class="siege-lb-empty">
          No adventurers found matching your search.
        </div>
      `;
      return;
    }

    listContainer.innerHTML = this.filteredData.map((user, index) => {
      const isTop3 = user.rank <= 3;
      const medal = user.rank === 1 ? '👑' : user.rank === 2 ? '🥈' : user.rank === 3 ? '🥉' : '';

      return `
        <div class="siege-lb-entry ${isTop3 ? 'siege-lb-top3' : ''}" data-rank="${user.rank}">
          <div class="siege-lb-rank">
            ${medal ? `<span class="siege-lb-medal">${medal}</span>` : ''}
            <span class="siege-lb-rank-num">${user.rank}</span>
          </div>
          <div class="siege-lb-user">
            <div class="siege-lb-name">${user.display_name || user.name}</div>
          </div>
          <div class="siege-lb-coins">
            <span class="siege-lb-coin-icon">🪙</span>
            <span class="siege-lb-coin-amount">${user.coins.toLocaleString()}</span>
          </div>
        </div>
      `;
    }).join('');
  },

  render() {
    const modal = document.createElement('div');
    modal.className = 'siege-modal-overlay';
    modal.id = 'siege-leaderboard-modal';
    modal.style.display = 'flex';
    modal.innerHTML = `
      <div class="siege-modal-container siege-lb-modal-container">
        <div class="siege-modal-content siege-lb-content">
          <div class="siege-lb-header">
            <h3 class="siege-modal-title">⚔️ Hall of Champions ⚔️</h3>
            <button class="siege-lb-close">✕</button>
          </div>

          <div class="siege-lb-search-container">
            <input
              type="text"
              class="siege-leaderboard-search"
              placeholder="Search adventurers..."
            />
          </div>

          <div class="siege-leaderboard-list"></div>
        </div>
      </div>
    `;

    document.body.appendChild(modal);

    const closeBtn = modal.querySelector('.siege-lb-close');
    const searchInput = modal.querySelector('.siege-leaderboard-search');

    closeBtn.addEventListener('click', () => this.close());
    modal.addEventListener('click', (e) => {
      if (e.target === modal) this.close();
    });
    searchInput.addEventListener('input', (e) => this.filter(e.target.value));

    const escHandler = (e) => {
      if (e.key === 'Escape') {
        this.close();
        document.removeEventListener('keydown', escHandler);
      }
    };
    document.addEventListener('keydown', escHandler);

    this.updateList();
  }
};

const catacombsIntelPanel = {
  currentTab: 'personal',
  userData: null,
  shopData: null,
  progressData: null,
  userCoins: 0,
  dataLoaded: false,
  initialized: false,

  createEmbeddedUI() {
    return `
      <div id="siege-catacombs-intel">
        <button id="catacombs-close-btn" title="Close panel">✕</button>

        <div class="catacombs-header">
          <h1 class="catacombs-title">Catacombs Intelligence</h1>
          <p class="catacombs-subtitle">Strategic insights and analytics</p>
        </div>

        <div class="catacombs-tabs">
          <button class="catacombs-tab active" data-tab="personal">
            <span class="tab-icon">👤</span>
            <span class="tab-label">Personal Bets</span>
          </button>
          <button class="catacombs-tab" data-tab="global">
            <span class="tab-icon">🌐</span>
            <span class="tab-label">Global Bets</span>
          </button>
        </div>

        <div class="catacombs-content-card">
          <div class="catacombs-tab-content active" id="tab-personal">
            <div class="loading-state">Loading...</div>
          </div>
          <div class="catacombs-tab-content" id="tab-global">
            <div class="loading-state">Loading...</div>
          </div>
        </div>
      </div>
    `;
  },

  async init() {
    if (!window.location.pathname.includes('/catacombs')) return;

    if (this.initialized) {
      return;
    }

    const mystereepleDialogue = document.querySelector('.mystereeple-dialogue');
    const hoverOverlay = document.querySelector('.hover-overlay');
    if (mystereepleDialogue) {
      mystereepleDialogue.style.display = 'none';
    }
    if (hoverOverlay) {
      hoverOverlay.style.display = 'none';
    }

    const appMain = document.querySelector('.app-main');
    if (appMain && !document.getElementById('siege-catacombs-intel')) {
      appMain.insertAdjacentHTML('beforeend', this.createEmbeddedUI());
    }

    this.setupEventListeners();

    this.initialized = true;
    await this.loadData();
    this.renderCurrentTab();
  },

  setupEventListeners() {
    document.querySelectorAll('.catacombs-tab').forEach(tab => {
      tab.addEventListener('click', (e) => {
        const tabName = e.target.dataset.tab;
        this.switchTab(tabName);
      });
    });

    const closeBtn = document.getElementById('catacombs-close-btn');
    if (closeBtn) {
      closeBtn.addEventListener('click', () => {
        const panel = document.getElementById('siege-catacombs-intel');
        if (panel) {
          panel.remove();
        }
        const mystereepleDialogue = document.querySelector('.mystereeple-dialogue');
        const hoverOverlay = document.querySelector('.hover-overlay');
        if (mystereepleDialogue) {
          mystereepleDialogue.style.display = '';
        }
        if (hoverOverlay) {
          hoverOverlay.style.display = '';
        }
        this.initialized = false;
      });
    }
  },

  switchTab(tabName) {
    this.currentTab = tabName;

    document.querySelectorAll('.catacombs-tab').forEach(tab => {
      tab.classList.toggle('active', tab.dataset.tab === tabName);
    });

    document.querySelectorAll('.catacombs-tab-content').forEach(content => {
      content.classList.toggle('active', content.id === `tab-${tabName}`);
    });

    if (this.dataLoaded) {
      this.renderCurrentTab();
    }
  },

  async loadData() {
    try {
      const csrfToken = document.querySelector('meta[name="csrf-token"]')?.content;

      const coinsResponse = await fetch('https://siege.hackclub.com/market/user_coins', {
        headers: { 'X-CSRF-Token': csrfToken }
      });
      const coinsData = await coinsResponse.json();
      this.userCoins = coinsData.coins || 0;

      const progressResponse = await fetch('https://siege.hackclub.com/catacombs/current_progress', {
        headers: { 'X-CSRF-Token': csrfToken }
      });
      this.progressData = await progressResponse.json();

      const shopResponse = await fetch('https://siege.hackclub.com/catacombs/shop_items');
      this.shopData = await shopResponse.json();

      this.dataLoaded = true;
    } catch (error) {
      console.error('[Catacombs Intel] Failed to load data:', error);
      this.dataLoaded = false;
    }
  },

  renderCurrentTab() {
    switch (this.currentTab) {
      case 'personal':
        this.renderPersonalTab();
        break;
      case 'global':
        this.renderGlobalTab();
        break;
    }
  },

  async renderPersonalTab() {
    const container = document.getElementById('tab-personal');
    if (!container) return;

    if (!this.dataLoaded || !this.progressData) {
      container.innerHTML = '<div class="loading-state">Loading...</div>';
      return;
    }

    const { personal_hours = 0 } = this.progressData;

    let selectedBetHours = 0;
    let betAmount = 0;
    let selectedBetMultiplier = 1.5;
    let hasPersonalBet = false;

    const personalBetInfo = document.querySelector('#personal-betting-content .bet-info');
    if (personalBetInfo) {
      hasPersonalBet = true;

      const goalText = personalBetInfo.querySelector('.global-stat:nth-child(1) .global-stat-value')?.textContent;
      if (goalText) {
        selectedBetHours = parseFloat(goalText) || 0;
      }

      const coinsText = personalBetInfo.querySelector('.global-stat:nth-child(2) .global-stat-value')?.textContent;
      if (coinsText) {
        betAmount = parseInt(coinsText) || 0;
      }

      const payoutText = personalBetInfo.querySelector('.global-payout .global-payout-value')?.textContent;
      if (payoutText) {
        const payout = parseInt(payoutText) || 0;
        if (betAmount > 0) {
          selectedBetMultiplier = payout / betAmount;
        }
      }
    }

    let html = '<div class="dashboard-grid">';

    const personalRec = await this.getPersonalBetRecommendation();

    if (hasPersonalBet && selectedBetHours > 0) {
      const progressPercent = Math.min((personal_hours / selectedBetHours) * 100, 100);
      const payout = Math.floor(betAmount * selectedBetMultiplier);

      html += `
        <div class="bet-info-card" style="margin-top: 0.75rem;">
          <h3>Personal Bet Active</h3>
          <div class="bet-stat">
            <span class="bet-label">Goal:</span>
            <span class="bet-value">${selectedBetHours}h</span>
          </div>
          <div class="bet-stat">
            <span class="bet-label">Coins Bet:</span>
            <span class="bet-value">${betAmount}</span>
          </div>
          <div class="bet-stat">
            <span class="bet-label">Potential Payout:</span>
            <span class="bet-value">${payout} coins</span>
          </div>
          <div class="bet-progress-container">
            <div class="bet-progress-label">Your Progress:</div>
            <div class="bet-progress-bar">
              <div class="bet-progress-fill" style="width: ${progressPercent}%"></div>
            </div>
            <div class="bet-progress-text">${personal_hours.toFixed(1)}h / ${selectedBetHours}h (${progressPercent.toFixed(1)}%)</div>
          </div>
        </div>
      `;
    } else {
      html += `
        <div class="dashboard-card">
          <h3>🎯 Personal Bet</h3>

          ${personalRec ? `
            <div style="margin-bottom: 0.6rem; padding: 0.5rem; background: rgba(75, 115, 195, 0.13); border: 1px solid rgba(95, 135, 215, 0.28); border-radius: 5px; font-size: 0.82rem;">
              <div style="margin-bottom: 0.3rem;"><strong style="color: #d4c8ff;">${personalRec.avgHours}h avg</strong></div>
              <div style="color: rgba(195, 215, 235, 0.92); font-size: 0.79rem; line-height: 1.5;">
                <div>🛡️ Safe: ${personalRec.safe.hours}h (${personalRec.safe.chance}% chance, ${personalRec.safe.risk}% risk) - Bet ${personalRec.safe.bet} coins</div>
                <div style="margin-top: 0.2rem;">🎲 Risky: ${personalRec.risky.hours}h (${personalRec.risky.chance}% chance, ${personalRec.risky.risk}% risk) - Bet ${personalRec.risky.bet} coins</div>
              </div>
            </div>
          ` : ''}

          <div class="bet-form-group">
            <label class="bet-form-label">Hours Goal</label>
            <select class="bet-form-select" id="bet-hours-goal">
              <option value="15">15h (1.5x)</option>
              <option value="20">20h (2x)</option>
              <option value="25">25h (2.5x)</option>
            </select>
          </div>
          <div class="bet-form-group">
            <label class="bet-form-label">Bet Amount (max 50)</label>
            <input type="number" class="bet-form-input" id="bet-amount" value="25" min="1" max="50">
          </div>
          <button class="intel-button" id="place-bet-btn">Place Bet</button>
        </div>
      `;
    }

    if (personalRec && personalRec.weekLabels && personalRec.historicalValues && personalRec.weekLabels.length >= 2) {
      html += `
        <div class="dashboard-card">
          <h3>📈 Personal History</h3>
          <div class="chart-container">
            <div class="chart-loading">Loading chart...</div>
            <canvas id="personal-chart"></canvas>
          </div>
        </div>
      `;
    } else {
      html += `
        <div class="dashboard-card">
          <h3>📈 Personal History</h3>
          <div style="padding: 2rem; text-align: center; color: rgba(200, 200, 210, 0.7); font-size: 0.9rem;">
            <p>Not enough data yet. Complete projects for at least 2 weeks to see your history chart!</p>
          </div>
        </div>
      `;
    }

    html += '</div>';

    container.innerHTML = html;

    if (!hasPersonalBet) {
      const placeBetBtn = document.getElementById('place-bet-btn');
      if (placeBetBtn) {
        placeBetBtn.addEventListener('click', () => this.placePersonalBet());
      }
    }

    if (personalRec && personalRec.weekLabels && personalRec.historicalValues && personalRec.weekLabels.length >= 2) {
      setTimeout(() => {
        document.querySelectorAll('.chart-loading').forEach(el => el.style.display = 'none');
        this.renderPersonalChart('personal-chart', personalRec.weekLabels, personalRec.historicalValues);
      }, 100);
    }
  },

  async renderGlobalTab() {
    const container = document.getElementById('tab-global');
    if (!container) return;

    if (!this.dataLoaded || !this.progressData) {
      container.innerHTML = '<div class="loading-state">Loading...</div>';
      return;
    }

    const { global_hours = 0 } = this.progressData;

    let hoursPrediction = 0;
    let globalBetAmount = 0;
    let globalMultiplier = 1.5;
    let hasGlobalBet = false;

    const globalBetInfo = document.querySelector('#global-betting-content .bet-info');
    if (globalBetInfo) {
      hasGlobalBet = true;

      const predictionText = globalBetInfo.querySelector('.global-stat:nth-child(1) .global-stat-value')?.textContent;
      if (predictionText) {
        hoursPrediction = parseFloat(predictionText) || 0;
      }

      const coinsText = globalBetInfo.querySelector('.global-stat:nth-child(2) .global-stat-value')?.textContent;
      if (coinsText) {
        globalBetAmount = parseInt(coinsText) || 0;
      }

      const payoutText = globalBetInfo.querySelector('.global-payout .global-payout-value')?.textContent;
      if (payoutText) {
        const payout = parseInt(payoutText) || 0;
        if (globalBetAmount > 0) {
          globalMultiplier = payout / globalBetAmount;
        }
      }
    }

    let html = '<div class="dashboard-grid">';

    const globalPred = await this.getGlobalBetPrediction();
    this.cachedGlobalPrediction = globalPred;

    if (hasGlobalBet && hoursPrediction > 0) {
      const progressPercent = Math.min((global_hours / hoursPrediction) * 100, 100);
      const payout = Math.floor(globalBetAmount * globalMultiplier);

      html += `
        <div class="bet-info-card" style="margin-top: 0.75rem;">
          <h3>Global Bet Active</h3>
          <div class="bet-stat">
            <span class="bet-label">Prediction:</span>
            <span class="bet-value">${hoursPrediction}h</span>
          </div>
          <div class="bet-stat">
            <span class="bet-label">Coins Bet:</span>
            <span class="bet-value">${globalBetAmount}</span>
          </div>
          <div class="bet-stat">
            <span class="bet-label">Potential Payout:</span>
            <span class="bet-value">${payout} coins</span>
          </div>
          <div class="bet-progress-container">
            <div class="bet-progress-label">Global Progress:</div>
            <div class="bet-progress-bar">
              <div class="bet-progress-fill" style="width: ${progressPercent}%"></div>
            </div>
            <div class="bet-progress-text">${global_hours.toFixed(1)}h / ${hoursPrediction}h (${progressPercent.toFixed(1)}%)</div>
          </div>
        </div>
      `;
    } else {
      html += `
        <div class="dashboard-card">
          <h3>🌍 Global Bet</h3>

          ${globalPred && globalPred.riskStats ? `
            <div style="margin-bottom: 0.6rem; padding: 0.6rem; background: rgba(95, 85, 185, 0.12); border: 1px solid rgba(115, 105, 205, 0.3); border-radius: 6px;">
              <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 0.5rem;">
                <div><strong style="color: #d4c8ff; font-size: 0.88rem;">Betting Probabilities</strong></div>
                <div style="font-size: 0.7rem; color: #e0e0e8;">
                  Confidence: <strong style="color: ${globalPred.riskStats.confidenceRating === 'High' ? '#10b981' : globalPred.riskStats.confidenceRating === 'Medium' ? '#f59e0b' : '#ef4444'};">${globalPred.riskStats.confidenceRating}</strong>
                </div>
              </div>

              <div style="display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 0.35rem;">
                <div style="padding: 0.4rem; background: rgba(16, 185, 129, 0.12); border: 1px solid rgba(16, 185, 129, 0.35); border-radius: 4px;">
                  <div style="text-align: center; margin-bottom: 0.3rem;">
                    <div style="font-size: 0.68rem; color: #c8c8d8; margin-bottom: 0.1rem;">SAFE</div>
                    <div style="font-size: 1.1rem; font-weight: bold; color: #34d399;">${globalPred.safe}h</div>
                    <div style="font-size: 0.75rem; font-weight: 600; color: #34d399; margin-top: 0.1rem;">${globalPred.riskStats.safeSuccess}% chance</div>
                  </div>
                  <div style="padding: 0.25rem; background: rgba(0,0,0,0.25); border-radius: 3px; font-size: 0.68rem;">
                    <div style="display: flex; justify-content: space-between; margin-bottom: 0.15rem;">
                      <span style="color: #c8c8d8;">Bet:</span>
                      <span style="font-weight: 600; color: #f0f0f8;">${globalPred.riskStats.safeBet} coins</span>
                    </div>
                    <div style="display: flex; justify-content: space-between; margin-bottom: 0.15rem;">
                      <span style="color: #c8c8d8;">EV:</span>
                      <span style="font-weight: 600; color: ${globalPred.riskStats.safeEV > 0 ? '#10b981' : '#ef4444'};">${globalPred.riskStats.safeEV > 0 ? '+' : ''}${globalPred.riskStats.safeEV}</span>
                    </div>
                    <div style="display: flex; justify-content: space-between;">
                      <span style="color: #c8c8d8;">Mult:</span>
                      <span style="font-weight: 600; color: #f0f0f8;">${globalPred.riskStats.safeMultiplier}x</span>
                    </div>
                  </div>
                </div>

                <div style="padding: 0.4rem; background: rgba(59, 130, 246, 0.12); border: 1px solid rgba(59, 130, 246, 0.35); border-radius: 4px;">
                  <div style="text-align: center; margin-bottom: 0.3rem;">
                    <div style="font-size: 0.68rem; color: #c8c8d8; margin-bottom: 0.1rem;"> EXPECTED</div>
                    <div style="font-size: 1.1rem; font-weight: bold; color: #60a5fa;">${globalPred.expected}h</div>
                    <div style="font-size: 0.75rem; font-weight: 600; color: #60a5fa; margin-top: 0.1rem;">${globalPred.riskStats.expectedSuccess}% chance</div>
                  </div>
                  <div style="padding: 0.25rem; background: rgba(0,0,0,0.25); border-radius: 3px; font-size: 0.68rem;">
                    <div style="display: flex; justify-content: space-between; margin-bottom: 0.15rem;">
                      <span style="color: #c8c8d8;">Bet:</span>
                      <span style="font-weight: 600; color: #f0f0f8;">${globalPred.riskStats.expectedBet} coins</span>
                    </div>
                    <div style="display: flex; justify-content: space-between; margin-bottom: 0.15rem;">
                      <span style="color: #c8c8d8;">EV:</span>
                      <span style="font-weight: 600; color: ${globalPred.riskStats.expectedEV > 0 ? '#10b981' : '#ef4444'};">${globalPred.riskStats.expectedEV > 0 ? '+' : ''}${globalPred.riskStats.expectedEV}</span>
                    </div>
                    <div style="display: flex; justify-content: space-between;">
                      <span style="color: #c8c8d8;">Mult:</span>
                      <span style="font-weight: 600; color: #f0f0f8;">${globalPred.riskStats.expectedMultiplier}x</span>
                    </div>
                  </div>
                </div>

                <div style="padding: 0.4rem; background: rgba(245, 158, 11, 0.12); border: 1px solid rgba(245, 158, 11, 0.35); border-radius: 4px;">
                  <div style="text-align: center; margin-bottom: 0.3rem;">
                    <div style="font-size: 0.68rem; color: #c8c8d8; margin-bottom: 0.1rem;">RISKY</div>
                    <div style="font-size: 1.1rem; font-weight: bold; color: #fbbf24;">${globalPred.risky}h</div>
                    <div style="font-size: 0.75rem; font-weight: 600; color: #fbbf24; margin-top: 0.1rem;">${globalPred.riskStats.riskySuccess}% chance</div>
                  </div>
                  <div style="padding: 0.25rem; background: rgba(0,0,0,0.25); border-radius: 3px; font-size: 0.68rem;">
                    <div style="display: flex; justify-content: space-between; margin-bottom: 0.15rem;">
                      <span style="color: #c8c8d8;">Bet:</span>
                      <span style="font-weight: 600; color: #f0f0f8;">${globalPred.riskStats.riskyBet} coins</span>
                    </div>
                    <div style="display: flex; justify-content: space-between; margin-bottom: 0.15rem;">
                      <span style="color: #c8c8d8;">EV:</span>
                      <span style="font-weight: 600; color: ${globalPred.riskStats.riskyEV > 0 ? '#10b981' : '#ef4444'};">${globalPred.riskStats.riskyEV > 0 ? '+' : ''}${globalPred.riskStats.riskyEV}</span>
                    </div>
                    <div style="display: flex; justify-content: space-between;">
                      <span style="color: #c8c8d8;">Mult:</span>
                      <span style="font-weight: 600; color: #f0f0f8;">${globalPred.riskStats.riskyMultiplier}x</span>
                    </div>
                  </div>
                </div>
              </div>

              <div style="margin-top: 0.5rem; padding: 0.35rem; background: rgba(0,0,0,0.3); border-radius: 4px; font-size: 0.68rem; color: #e0e0e8; line-height: 1.4;">
                <div style="display: flex; justify-content: space-between; margin-bottom: 0.2rem;">
                  <span style="opacity: 0.7;">Algorithm Weights:</span>
                  <span style="font-weight: 600; color: #f0f0f8;">Exp ${globalPred.algorithmWeights?.exponential || 0}% | Power ${globalPred.algorithmWeights?.powerLaw || 0}%</span>
                </div>
              </div>
            </div>
          ` : ''}

          <div class="bet-form-group">
            <label class="bet-form-label">Predicted Hours</label>
            <input type="number" class="bet-form-input" id="global-hours-prediction" value="${globalPred ? globalPred.expected : 1000}" min="1" max="5000">
          </div>
          <div class="bet-form-group">
            <label class="bet-form-label">Multiplier</label>
            <div style="padding: 0.5rem; background: rgba(0,0,0,0.2); border-radius: 4px; border: 1px solid rgba(80, 80, 100, 0.3);">
              <span style="font-size: 1.1rem; font-weight: 600; color: #f59e0b;" id="global-multiplier-display">${globalPred && globalPred.riskStats && globalPred.riskStats.expectedMultiplier ? (typeof globalPred.riskStats.expectedMultiplier === 'number' ? globalPred.riskStats.expectedMultiplier.toFixed(2) : parseFloat(globalPred.riskStats.expectedMultiplier).toFixed(2)) : '1.50'}x</span>
            </div>
          </div>
          <div class="bet-form-group">
            <label class="bet-form-label">Bet Amount (max 200)</label>
            <input type="number" class="bet-form-input" id="global-bet-amount" value="25" min="1" max="200">
          </div>
          <div style="text-align: center; margin-bottom: 1rem; font-size: 1.1rem;">
            <span style="color: rgba(200, 200, 210, 0.7);">Estimated payout: </span>
            <span style="font-weight: 600; color: #10b981;" id="global-payout-display">${globalPred && globalPred.riskStats && globalPred.riskStats.expectedMultiplier ? Math.round(25 * (typeof globalPred.riskStats.expectedMultiplier === 'number' ? globalPred.riskStats.expectedMultiplier : parseFloat(globalPred.riskStats.expectedMultiplier))) : 38}</span>
            <span style="color: rgba(200, 200, 210, 0.7);"> coins</span>
          </div>
          <button class="intel-button" id="place-global-bet-btn">Place Global Bet</button>
        </div>
      `;
    }

    if (globalPred && globalPred.weekLabels && globalPred.historicalValues) {
      html += `
        <div class="dashboard-card">
          <h3>🌍 Global Predictions</h3>
          <div class="chart-container">
            <div class="chart-loading">Loading chart...</div>
            <canvas id="global-chart"></canvas>
          </div>
        </div>
      `;
    }

    html += '</div>';

    container.innerHTML = html;

    if (!hasGlobalBet) {
      const placeGlobalBetBtn = document.getElementById('place-global-bet-btn');
      if (placeGlobalBetBtn) {
        placeGlobalBetBtn.addEventListener('click', () => this.placeGlobalBet());
      }

      const hoursPredictionInput = document.getElementById('global-hours-prediction');
      const betAmountInput = document.getElementById('global-bet-amount');

      if (hoursPredictionInput) {
        hoursPredictionInput.addEventListener('input', (e) => {
          this.updateGlobalPrediction(e.target.value);
        });
      }

      if (betAmountInput) {
        betAmountInput.addEventListener('input', (e) => {
          this.updateGlobalBetAmount(e.target.value);
        });
      }
    }

    if (globalPred && globalPred.weekLabels && globalPred.historicalValues) {
      setTimeout(() => {
        document.querySelectorAll('.chart-loading').forEach(el => el.style.display = 'none');
        this.renderGlobalChart('global-chart', globalPred.weekLabels, globalPred.historicalValues, globalPred.algorithms);
      }, 100);
    }
  },

  updateNumber(element, targetValue, isMultiplier = false) {
    if (!element) return;

    const allWithSameId = document.querySelectorAll(`#${element.id}`);

    allWithSameId.forEach((el) => {
      if (isMultiplier) {
        el.textContent = targetValue.toFixed(2) + 'x';
      } else {
        el.textContent = Math.round(targetValue).toString();
      }
    });
  },

  updateGlobalPrediction(predictedHours) {
    const globalPrediction = this.cachedGlobalPrediction;

    if (!globalPrediction) {
      return;
    }

    if (!globalPrediction.historicalValues || globalPrediction.historicalValues.length < 1) {
      const displayElement = document.getElementById('global-multiplier-display');
      if (displayElement) {
        displayElement.textContent = '1.50x';
      }
      this.updateGlobalPayout(1.50);
      return;
    }

    const lastWeekHours = globalPrediction.historicalValues.length >= 2
      ? globalPrediction.historicalValues[globalPrediction.historicalValues.length - 2]
      : globalPrediction.historicalValues[globalPrediction.historicalValues.length - 1];

    const multiplier = this.calculateGlobalMultiplier(parseFloat(predictedHours), lastWeekHours);

    const displayElement = document.getElementById('global-multiplier-display');
    if (displayElement) {
      this.updateNumber(displayElement, multiplier, true);
    }

    this.updateGlobalPayout(multiplier);
  },

  updateGlobalBetAmount(betAmount) {
    const multiplierText = document.getElementById('global-multiplier-display')?.textContent;
    if (multiplierText) {
      const multiplier = parseFloat(multiplierText.replace('x', ''));
      this.updateGlobalPayout(multiplier);
    }
  },

  updateGlobalPayout(multiplier = null) {
    if (!multiplier) {
      const multiplierText = document.getElementById('global-multiplier-display')?.textContent;
      if (!multiplierText) return;
      multiplier = parseFloat(multiplierText.replace('x', ''));
    }

    const betAmount = parseInt(document.getElementById('global-bet-amount')?.value || 25);
    const payout = Math.round(betAmount * multiplier);
    const payoutDisplay = document.getElementById('global-payout-display');

    if (payoutDisplay) {
      this.updateNumber(payoutDisplay, payout, false);
    }
  },

  async placePersonalBet() {
    const hoursGoal = parseInt(document.getElementById('bet-hours-goal').value);
    const betAmount = parseInt(document.getElementById('bet-amount').value);

    if (betAmount > 50) {
      alert('Personal bet max is 50 coins!');
      return;
    }

    if (betAmount > this.userCoins) {
      alert('Not enough coins!');
      return;
    }

    if (betAmount < 1) {
      alert('Bet amount must be at least 1 coin');
      return;
    }

    const multiplierMap = { 15: 1.5, 20: 2, 25: 2.5 };
    const multiplier = multiplierMap[hoursGoal] || 1.5;

    try {
      const csrfToken = document.querySelector('meta[name="csrf-token"]')?.content;
      const response = await fetch('/catacombs/place_personal_bet', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-CSRF-Token': csrfToken
        },
        body: JSON.stringify({
          coin_amount: betAmount,
          hours_goal: hoursGoal,
          multiplier: multiplier
        })
      });

      const data = await response.json();

      if (data.success) {
        alert(`✅ Bet placed! Goal: ${hoursGoal}h, Amount: ${betAmount} coins`);
        await this.loadData();
        this.renderPersonalTab();
      } else {
        alert(`❌ Failed: ${data.message || 'Unknown error'}`);
      }
    } catch (error) {
      console.error('[Catacombs Intel] Failed to place bet:', error);
      alert('❌ Failed to place bet');
    }
  },

  async placeGlobalBet() {
    const hoursPrediction = parseInt(document.getElementById('global-hours-prediction').value);
    const betAmount = parseInt(document.getElementById('global-bet-amount').value);

    if (betAmount > 200) {
      alert('Global bet max is 200 coins!');
      return;
    }

    if (betAmount > this.userCoins) {
      alert('Not enough coins!');
      return;
    }

    if (betAmount < 1) {
      alert('Bet amount must be at least 1 coin');
      return;
    }

    const multiplier = 1.5;

    try {
      const csrfToken = document.querySelector('meta[name="csrf-token"]')?.content;
      const response = await fetch('/catacombs/place_global_bet', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-CSRF-Token': csrfToken
        },
        body: JSON.stringify({
          coin_amount: betAmount,
          predicted_hours: hoursPrediction,
          multiplier: multiplier
        })
      });

      const data = await response.json();

      if (data.success) {
        alert(`✅ Global bet placed! Prediction: ${hoursPrediction}h, Amount: ${betAmount} coins`);
        await this.loadData();
        this.renderGlobalTab();
      } else {
        alert(`❌ Failed: ${data.message || 'Unknown error'}`);
      }
    } catch (error) {
      console.error('[Catacombs Intel] Failed to place global bet:', error);
      alert('❌ Failed to place bet');
    }
  },


  async getPersonalBetRecommendation() {
    try {
      const statsData = JSON.parse(localStorage.getItem('siege-utils-project-stats') || '{}');
      const unshippedData = JSON.parse(localStorage.getItem('siege-utils-unshipped') || '{}');

      const userProjects = Object.values(statsData);
      const unshippedProjects = Object.values(unshippedData);

      if (userProjects.length === 0 && unshippedProjects.length === 0) {
        return null;
      }

      const weeklyHours = {};

      userProjects.forEach(project => {
        const week = project.week || 'Unknown';
        if (!weeklyHours[week]) {
          weeklyHours[week] = 0;
        }
        weeklyHours[week] += project.hours || 0;
      });

      unshippedProjects.forEach(project => {
        const week = project.week || 'Unknown';
        if (!weeklyHours[week]) {
          weeklyHours[week] = 0;
        }
        weeklyHours[week] += project.initialHours || 0;
      });

      const parseWeekNumber = (weekStr) => {
        const match = weekStr.match(/Week\s+(\d+)/i);
        if (match) {
          return parseInt(match[1], 10);
        }
        const num = parseInt(weekStr, 10);
        return isNaN(num) ? null : num;
      };


      const weekNumbers = Object.keys(weeklyHours)
        .map(w => ({ str: w, num: parseWeekNumber(w) }))
        .filter(w => w.num !== null)
        .sort((a, b) => a.num - b.num);


      if (weekNumbers.length === 0) {
        return null;
      }

      const minWeek = weekNumbers[0].num;
      const maxWeek = weekNumbers[weekNumbers.length - 1].num;


      for (let week = minWeek; week <= maxWeek; week++) {
        const weekStr = String(week);
        if (!weeklyHours[weekStr]) {
          weeklyHours[weekStr] = 0;
        }
      }

      const weeks = Object.keys(weeklyHours).sort((a, b) => {
        const numA = parseWeekNumber(a) || 0;
        const numB = parseWeekNumber(b) || 0;
        return numA - numB;
      });

      const weeksWithHours = weeks.filter(w => weeklyHours[w] > 0);

      let weightedSum = 0;
      let weightTotal = 0;

      weeksWithHours.forEach((week, index) => {
        const weekAgo = weeksWithHours.length - 1 - index;
        const weight = Math.exp(-weekAgo * 0.3);
        weightedSum += weeklyHours[week] * weight;
        weightTotal += weight;
      });

      const avgHours = weightTotal > 0 ? weightedSum / weightTotal : 0;
      const personalBest = Math.max(...weeks.map(w => weeklyHours[w]));

      const hoursArray = weeksWithHours.map(w => weeklyHours[w]);
      const mean = hoursArray.reduce((a, b) => a + b, 0) / hoursArray.length;
      const variance = hoursArray.reduce((sum, val) => sum + Math.pow(val - mean, 2), 0) / hoursArray.length;
      const stdDev = Math.sqrt(variance);

      let trendSlope = 0;
      if (weeksWithHours.length >= 3) {
        const n = weeksWithHours.length;
        const dataPoints = weeksWithHours.map((w, idx) => ({
          x: idx,
          y: weeklyHours[w]
        }));

        const sumX = dataPoints.reduce((sum, p) => sum + p.x, 0);
        const sumY = dataPoints.reduce((sum, p) => sum + p.y, 0);
        const sumXY = dataPoints.reduce((sum, p) => sum + (p.x * p.y), 0);
        const sumX2 = dataPoints.reduce((sum, p) => sum + (p.x * p.x), 0);

        const slope = (n * sumXY - sumX * sumY) / (n * sumX2 - sumX * sumX);

        trendSlope = slope / (avgHours || 1);

        if (weeksWithHours.length >= 6) {
          const recent3Points = dataPoints.slice(-3);
          const n3 = recent3Points.length;
          const sumX3 = recent3Points.reduce((sum, p, idx) => sum + idx, 0);
          const sumY3 = recent3Points.reduce((sum, p) => sum + p.y, 0);
          const sumXY3 = recent3Points.reduce((sum, p, idx) => sum + (idx * p.y), 0);
          const sumX23 = recent3Points.reduce((sum, p, idx) => sum + (idx * idx), 0);

          const recentSlope = (n3 * sumXY3 - sumX3 * sumY3) / (n3 * sumX23 - sumX3 * sumX3);
          const recentTrend = recentSlope / (avgHours || 1);

          trendSlope = 0.6 * recentTrend + 0.4 * trendSlope;
        }
      }

      const goals = [
        { hours: 15, multiplier: 1.5 },
        { hours: 20, multiplier: 2.0 },
        { hours: 25, multiplier: 2.5 }
      ];

      const goalsWithStats = goals.map(goal => {
        let chance;

        const adjustedMean = avgHours * (1 + trendSlope * 0.5);
        const zScore = (goal.hours - adjustedMean) / (stdDev || 1);

        if (zScore <= 0) {
          chance = 95 - (Math.abs(zScore) * 15);
        } else if (zScore <= 1.0) {
          chance = 80 - (zScore * 30);
        } else if (zScore <= 2.0) {
          chance = 50 - ((zScore - 1.0) * 35);
        } else {
          chance = 15 * Math.exp(-(zScore - 2.0) * 0.8);
        }

        const consistencyFactor = stdDev / (avgHours || 1);
        if (consistencyFactor < 0.3 && goal.hours <= avgHours * 1.2) {
          chance = Math.min(95, chance * 1.15);
        }

        chance = Math.max(1, Math.min(95, Math.round(chance)));
        const risk = 100 - chance;

        const p = chance / 100;
        const q = 1 - p;
        const maxBet = 50;

        const confidenceScore = Math.max(0, Math.min(1, (p - 0.3) / 0.4));
        const edge = p * (goal.multiplier - 1) - q;
        const edgeScore = Math.max(0, Math.min(1, (edge + 0.5) / 1.0));
        const combinedScore = 0.7 * confidenceScore + 0.3 * edgeScore;
        const aggressiveFactor = Math.pow(combinedScore, 0.7);
        const bet = Math.max(10, Math.min(maxBet, Math.round(aggressiveFactor * maxBet)));

        return {
          hours: goal.hours,
          multiplier: goal.multiplier,
          chance,
          risk,
          bet
        };
      });

      const sortedByChance = [...goalsWithStats].sort((a, b) => b.chance - a.chance);
      const safeGoal = sortedByChance[0];
      const riskyGoal = sortedByChance.find(g => g.chance >= 10 && g.hours > safeGoal.hours) || sortedByChance[sortedByChance.length - 1];

      const safeHours = safeGoal.hours;
      const safeChance = safeGoal.chance;
      const safeRisk = safeGoal.risk;
      const safeBet = safeGoal.bet;

      const riskyHours = riskyGoal.hours;
      const riskyChance = riskyGoal.chance;
      const riskyRisk = riskyGoal.risk;
      const riskyBet = riskyGoal.bet;

      const weekValues = weeks.map(w => weeklyHours[w]);

      return {
        safe: { hours: safeHours, chance: safeChance, risk: safeRisk, bet: safeBet },
        risky: { hours: riskyHours, chance: riskyChance, risk: riskyRisk, bet: riskyBet },
        avgHours: avgHours.toFixed(1),
        weeklyData: weeklyHours,
        weekLabels: weeks,
        historicalValues: weekValues
      };
    } catch (error) {
      console.error('[Catacombs Intel] Failed to get personal recommendation:', error);
      return null;
    }
  },

  async getGlobalBetPrediction() {
    try {
      const response = await fetch('https://siege.hackclub.com/api/public-beta/projects');
      const data = await response.json();

      if (!data.projects || data.projects.length === 0) {
        return null;
      }

      const parseWeekNumber = (weekText) => {
        const match = weekText ? weekText.match(/Week\s+(\d+)/i) : null;
        return match ? parseInt(match[1], 10) : null;
      };

      const minimumWeek = 5;
      const weeklyBuckets = new Map();

      data.projects.forEach(project => {
        const weekNumber = parseWeekNumber(project.week_badge_text);
        if (!weekNumber || weekNumber < minimumWeek) {
          return;
        }

        const hours = Number(project.hours) || 0;
        const status = (project.status || '').toLowerCase();

        if (!weeklyBuckets.has(weekNumber)) {
          weeklyBuckets.set(weekNumber, { building: 0, other: 0 });
        }
        const bucket = weeklyBuckets.get(weekNumber);
        const isBuilding = status === 'building' || status === 'in progress';
        if (isBuilding) {
          bucket.building += hours;
        } else {
          bucket.other += hours;
        }
      });

      if (weeklyBuckets.size === 0) {
        return null;
      }

      const allWeekNumbers = Array.from(weeklyBuckets.keys());
      if (allWeekNumbers.length === 0) {
        return null;
      }

      let currentWeek = typeof utils.getCurrentWeek === 'function' ? utils.getCurrentWeek() : null;
      if (!Number.isFinite(currentWeek)) {
        currentWeek = null;
      }
      if (currentWeek === null) {
        currentWeek = Math.max(...allWeekNumbers);
      }

      const weeklyHoursMap = new Map();
      allWeekNumbers.forEach(weekNumber => {
        const bucket = weeklyBuckets.get(weekNumber);
        const includeBuilding = weekNumber >= currentWeek;
        const totalHours = includeBuilding ? bucket.other + bucket.building : bucket.other;
        weeklyHoursMap.set(weekNumber, totalHours);
      });

      if (weeklyHoursMap.size === 0) {
        return null;
      }

      const minWeek = Math.min(...allWeekNumbers);
      const maxWeek = Math.max(...allWeekNumbers);

      for (let week = minWeek; week <= maxWeek; week++) {
        if (!weeklyHoursMap.has(week)) {
          weeklyHoursMap.set(week, 0);
        }
      }

      const sortedWeekEntries = Array.from(weeklyHoursMap.entries()).sort((a, b) => a[0] - b[0]);
      const weekNumbers = sortedWeekEntries.map(([week]) => week);
      const values = sortedWeekEntries.map(([, hours]) => Math.round(hours * 10) / 10);
      const weekLabels = weekNumbers.map(week => `Week ${week}`);

      const weeklyHours = {};
      sortedWeekEntries.forEach(([week, hours]) => {
        weeklyHours[`Week ${week}`] = Math.round(hours * 10) / 10;
      });

      if (values.length === 0) {
        return null;
      }

      const algorithms = this.getAlgorithms(null, values);

      const mean = values.reduce((a, b) => a + b, 0) / values.length;
      const variance = values.reduce((sum, val) => sum + Math.pow(val - mean, 2), 0) / values.length;
      const stdDev = Math.sqrt(variance);

      let safe, expected, risky;

      if (algorithms && algorithms.exponential && algorithms.powerLaw && algorithms.weightedAverage) {
        const expPred = algorithms.exponential.prediction;
        const powPred = algorithms.powerLaw.prediction;
        const weightedPred = algorithms.weightedAverage.prediction;

        expected = weightedPred;

        const lowerBound = Math.min(expPred, powPred);
        const upperBound = Math.max(expPred, powPred);
        const spread = Math.abs(upperBound - lowerBound);

        safe = Math.round(expected - spread * 0.5);
        risky = Math.round(expected + spread * 0.5);
      } else {
        expected = Math.round(mean);
        safe = Math.round(expected - stdDev * 0.5);
        risky = Math.round(expected + stdDev * 0.5);
      }

      const range = `${safe}-${risky}h`;

      const algorithmWeights = algorithms && algorithms.weightedAverage
        ? algorithms.weightedAverage.weights
        : null;

      const standardError = stdDev / Math.sqrt(values.length);

      const normalCDF = (x, mean, stdDev) => {
        if (stdDev === 0) return x >= mean ? 1 : 0;
        const z = (x - mean) / stdDev;
        const t = 1 / (1 + 0.2316419 * Math.abs(z));
        const d = 0.3989423 * Math.exp(-z * z / 2);
        const prob = d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274))));
        return z > 0 ? 1 - prob : prob;
      };

      const safeSuccess = Math.round((1 - normalCDF(safe, expected, stdDev)) * 100);
      const expectedSuccess = Math.round((1 - normalCDF(expected, expected, stdDev)) * 100);
      const riskySuccess = Math.round((1 - normalCDF(risky, expected, stdDev)) * 100);

      const safeRisk = 100 - safeSuccess;
      const expectedRisk = 100 - expectedSuccess;
      const riskyRisk = 100 - riskySuccess;

      const lastWeekHours = values.length >= 2 ? values[values.length - 2] : (values.length >= 1 ? values[values.length - 1] : null);

      const calculateOptimalBet = (targetHours, successProb) => {
        const multiplier = this.calculateGlobalMultiplier(targetHours, lastWeekHours);
        const p = successProb / 100;
        const q = 1 - p;
        const maxBet = 200;

        const edgePerUnit = (p * (multiplier - 1)) - (1 - p);
        const normalizedEdge = Math.min(Math.abs(edgePerUnit) / 0.5, 1);
        const evBet = edgePerUnit > 0
          ? Math.round(normalizedEdge * maxBet)
          : Math.round(0.05 * maxBet);

        const expectedReturn = p * (multiplier - 1) - q;
        const variance = p * Math.pow(multiplier - 1, 2) + q * Math.pow(-1, 2);
        const stdDev = Math.sqrt(variance);
        const sharpeRatio = stdDev > 0 ? expectedReturn / stdDev : 0;
        const normalizedSharpe = Math.max(0, Math.min(1, (sharpeRatio + 1) / 2));
        const sharpeBet = Math.round(normalizedSharpe * maxBet);

        const b = multiplier - 1;
        const kellyFraction = b > 0 ? Math.max(0, (p * b - q) / b) : 0;
        const kellyBet = kellyFraction * maxBet * 0.5;
        const confidenceFloor = p >= 0.6 ? 0.3 : (p >= 0.5 ? 0.2 : 0.1);
        const floorBet = confidenceFloor * maxBet;
        const modKellyBet = Math.round(Math.max(kellyBet, floorBet));

        const riskTolerance = 0.7;
        let maxUtility = -Infinity;
        let utilityBet = 5;
        for (let bet = 5; bet <= maxBet; bet += 5) {
          const evWin = p * bet * multiplier;
          const evLose = q * (-bet);
          const expectedValue = evWin + evLose;
          const riskPenalty = (1 - riskTolerance) * variance * bet;
          const utility = expectedValue - riskPenalty;

          if (utility > maxUtility) {
            maxUtility = utility;
            utilityBet = bet;
          }
        }

        const confidenceScore = Math.max(0, Math.min(1, (p - 0.3) / 0.4));
        const edge = p * (multiplier - 1) - q;
        const edgeScore = Math.max(0, Math.min(1, (edge + 0.5) / 1.0));
        const combinedScore = 0.7 * confidenceScore + 0.3 * edgeScore;
        const aggressiveFactor = Math.pow(combinedScore, 0.7);
        const weightedEdgeBet = Math.round(aggressiveFactor * maxBet);

        const algorithms = {
          evProportional: Math.max(5, Math.min(maxBet, evBet)),
          sharpe: Math.max(5, Math.min(maxBet, sharpeBet)),
          modKelly: Math.max(5, Math.min(maxBet, modKellyBet)),
          utility: Math.max(5, Math.min(maxBet, utilityBet)),
          weightedEdge: Math.max(5, Math.min(maxBet, weightedEdgeBet))
        };

        const finalBet = algorithms.weightedEdge;

        const winAmount = finalBet * multiplier;
        const lossAmount = finalBet;
        const ev = (p * winAmount) - (q * lossAmount);

        return {
          optimalBet: finalBet,
          ev: ev.toFixed(1),
          kellyPercent: Math.round(aggressiveFactor * 100),
          multiplier: multiplier.toFixed(2),
          algorithms
        };
      };

      const safeBetting = calculateOptimalBet(safe, safeSuccess);
      const expectedBetting = calculateOptimalBet(expected, expectedSuccess);
      const riskyBetting = calculateOptimalBet(risky, riskySuccess);

      let confidenceRating = 'Low';
      if (values.length >= 4 && standardError < stdDev * 0.7) {
        confidenceRating = values.length >= 5 && standardError < stdDev * 0.5 ? 'High' : 'Medium';
      }

      const riskStats = {
        safeSuccess,
        expectedSuccess,
        riskySuccess,
        safeRisk,
        expectedRisk,
        riskyRisk,
        confidenceRating,
        standardError: Math.round(standardError),
        dataPoints: values.length,
        safeBet: safeBetting.optimalBet,
        expectedBet: expectedBetting.optimalBet,
        riskyBet: riskyBetting.optimalBet,
        safeEV: safeBetting.ev,
        expectedEV: expectedBetting.ev,
        riskyEV: riskyBetting.ev,
        safeMultiplier: safeBetting.multiplier,
        expectedMultiplier: expectedBetting.multiplier,
        riskyMultiplier: riskyBetting.multiplier
      };

      return {
        safe,
        expected,
        risky,
        range,
        algorithmWeights,
        riskStats,
        weeklyData: weeklyHours,
        algorithms,
        historicalValues: values,
        weekLabels
      };
    } catch (error) {
      console.error('[Catacombs Intel] Failed to get global prediction:', error);
      return null;
    }
  },

  calculateGlobalMultiplier(predictedHours, lastWeekHours = null) {
    if (!lastWeekHours || lastWeekHours === 0) {
      return 1.5;
    }

    const percentage = predictedHours / lastWeekHours;

    if (percentage < 0.8) {
      return 1.0;
    } else if (percentage < 1.0) {
      const t = (percentage - 0.8) / 0.2;
      return 1.0 + 1.0 * (t * t);
    } else if (percentage < 1.05) {
      const t = (percentage - 1.0) / 0.05;
      return 2.0 + 0.5 * (t * t);
    } else {
      return 2.5 + 0.5 * Math.pow((percentage - 1.05) / 0.05, 2);
    }
  },

  getAlgorithms(weekNumbers, values) {
    if (!values || values.length < 3) {
      return null;
    }

    const n = values.length;
    const trainStart = Math.min(2, n - 1);
    const algs = {};

    const buildSeries = (predictor) => {
      const series = new Array(n).fill(null);
      series[0] = values[0];
      for (let i = 1; i < n; i++) {
        const trainData = values.slice(0, i);
        series[i] = predictor(trainData);
      }
      const nextPred = predictor(values.slice(0, n - 1));
      return { series, prediction: Math.round(nextPred) };
    };

    const expCurvePredictor = (trainData) => {
      const len = trainData.length;
      if (len < 2) return trainData[0];
      const logValues = trainData.map(v => Math.log(Math.max(v, 1)));
      let sumX = 0, sumY = 0, sumXY = 0, sumX2 = 0;
      for (let i = 0; i < len; i++) {
        sumX += i;
        sumY += logValues[i];
        sumXY += i * logValues[i];
        sumX2 += i * i;
      }
      const slope = (len * sumXY - sumX * sumY) / (len * sumX2 - sumX * sumX);
      const intercept = (sumY - slope * sumX) / len;
      return Math.exp(intercept + slope * len);
    };
    const expCurveResult = buildSeries(expCurvePredictor);
    algs.exponential = {
      prediction: expCurveResult.prediction,
      series: expCurveResult.series,
      name: 'Exponential',
      color: '#10b981'
    };

    const powerLawPredictor = (trainData) => {
      const len = trainData.length;
      if (len < 2) return trainData[0];
      const logX = [], logY = [];
      for (let i = 0; i < len; i++) {
        logX.push(Math.log(i + 1));
        logY.push(Math.log(Math.max(trainData[i], 1)));
      }
      let sumX = 0, sumY = 0, sumXY = 0, sumX2 = 0;
      for (let i = 0; i < len; i++) {
        sumX += logX[i];
        sumY += logY[i];
        sumXY += logX[i] * logY[i];
        sumX2 += logX[i] * logX[i];
      }
      const slope = (len * sumXY - sumX * sumY) / (len * sumX2 - sumX * sumX);
      const intercept = (sumY - slope * sumX) / len;
      return Math.exp(intercept) * Math.pow(len + 1, slope);
    };
    const powerLawResult = buildSeries(powerLawPredictor);
    algs.powerLaw = {
      prediction: powerLawResult.prediction,
      series: powerLawResult.series,
      name: 'Power Law',
      color: '#3b82f6'
    };

    const calculateAdaptiveWeights = () => {
      if (n < 2) return { expWeight: 0.5, powWeight: 0.5 };

      let expErrors = [];
      let powErrors = [];

      for (let i = 1; i < n; i++) {
        const trainData = values.slice(0, i);
        const actual = values[i];

        const expPred = expCurvePredictor(trainData);
        const powPred = powerLawPredictor(trainData);

        expErrors.push(Math.abs(actual - expPred));
        powErrors.push(Math.abs(actual - powPred));
      }

      const expMAE = expErrors.reduce((sum, e) => sum + e, 0) / expErrors.length;
      const powMAE = powErrors.reduce((sum, e) => sum + e, 0) / powErrors.length;

      const expWeight = 1 / (expMAE + 1);
      const powWeight = 1 / (powMAE + 1);

      const total = expWeight + powWeight;

      return {
        expWeight: expWeight / total,
        powWeight: powWeight / total,
        expMAE,
        powMAE
      };
    };

    const weights = calculateAdaptiveWeights();

    const weightedAveragePredictor = (trainData) => {
      const expPred = expCurvePredictor(trainData);
      const powPred = powerLawPredictor(trainData);
      const weighted = (expPred * weights.expWeight) + (powPred * weights.powWeight);

      return weighted;
    };

    const weightedResult = buildSeries(weightedAveragePredictor);
    algs.weightedAverage = {
      prediction: weightedResult.prediction,
      series: weightedResult.series,
      name: 'Adaptive Weighted',
      color: '#f59e0b',
      weights: {
        exponential: Math.round(weights.expWeight * 100),
        powerLaw: Math.round(weights.powWeight * 100)
      }
    };

    return algs;
  },

  renderPersonalChart(canvasId, weekLabels, historicalValues) {
    const canvas = document.getElementById(canvasId);
    if (!canvas) return;

    const ctx = canvas.getContext('2d');

    if (canvas.chart) {
      canvas.chart.destroy();
    }

    canvas.chart = new Chart(ctx, {
      type: 'line',
      data: {
        labels: weekLabels,
        datasets: [{
          label: 'Your Weekly Hours',
          data: historicalValues,
          borderColor: '#60a5fa',
          backgroundColor: 'rgba(96, 165, 250, 0.1)',
          tension: 0.3,
          fill: true
        }]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: {
            labels: { color: '#c8c8d8' }
          }
        },
        scales: {
          y: {
            beginAtZero: true,
            ticks: { color: '#a8a8b8' },
            grid: { color: 'rgba(100, 100, 120, 0.2)' }
          },
          x: {
            ticks: { color: '#a8a8b8' },
            grid: { color: 'rgba(100, 100, 120, 0.2)' }
          }
        }
      }
    });
  },

  renderGlobalChart(canvasId, weekLabels, historicalValues, algorithms) {
    const canvas = document.getElementById(canvasId);
    if (!canvas) return;

    const ctx = canvas.getContext('2d');

    if (canvas.chart) {
      canvas.chart.destroy();
    }

    const datasets = [{
      label: 'Historical Global Hours',
      data: historicalValues,
      borderColor: '#8b5cf6',
      backgroundColor: 'rgba(139, 92, 246, 0.1)',
      tension: 0.3,
      fill: true
    }];

    if (algorithms) {
      Object.values(algorithms).forEach(alg => {
        if (!alg.series || !Number.isFinite(alg.prediction)) return;
        const isAdaptiveWeighted = alg.name === 'Adaptive Weighted';
        datasets.push({
          label: `${alg.name}: ${alg.prediction}h`,
          data: alg.series,
          borderColor: alg.color,
          borderDash: [5, 5],
          borderWidth: 2,
          pointRadius: 2,
          fill: false,
          spanGaps: false,
          hidden: !isAdaptiveWeighted
        });
      });
    }

    canvas.chart = new Chart(ctx, {
      type: 'line',
      data: {
        labels: weekLabels,
        datasets: datasets
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: {
            labels: { color: '#c8c8d8', font: { size: 11 } },
            onClick: (e, legendItem, legend) => {
              const index = legendItem.datasetIndex;
              const chart = legend.chart;
              const meta = chart.getDatasetMeta(index);
              meta.hidden = !meta.hidden;
              chart.update();
            }
          }
        },
        scales: {
          y: {
            beginAtZero: false,
            ticks: { color: '#a8a8b8' },
            grid: { color: 'rgba(100, 100, 120, 0.2)' }
          },
          x: {
            ticks: { color: '#a8a8b8', maxRotation: 45 },
            grid: { color: 'rgba(100, 100, 120, 0.2)' }
          }
        }
      }
    });
  },

  renderMultiplierChart(canvasId) {
    const canvas = document.getElementById(canvasId);
    if (!canvas) return;

    const ctx = canvas.getContext('2d');

    if (canvas.chart) {
      canvas.chart.destroy();
    }

    const hours = [];
    const multipliers = [];
    for (let h = 1000; h <= 2000; h += 50) {
      hours.push(h);
      multipliers.push(this.calculateGlobalMultiplier(h));
    }

    canvas.chart = new Chart(ctx, {
      type: 'line',
      data: {
        labels: hours,
        datasets: [{
          label: 'Global Multiplier Curve',
          data: multipliers,
          borderColor: '#10b981',
          backgroundColor: 'rgba(16, 185, 129, 0.1)',
          tension: 0.4,
          fill: true
        }]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: {
            labels: { color: '#c8c8d8' }
          }
        },
        scales: {
          y: {
            beginAtZero: true,
            title: { display: true, text: 'Multiplier', color: '#a8a8b8' },
            ticks: { color: '#a8a8b8' },
            grid: { color: 'rgba(100, 100, 120, 0.2)' }
          },
          x: {
            title: { display: true, text: 'Hours', color: '#a8a8b8' },
            ticks: { color: '#a8a8b8' },
            grid: { color: 'rgba(100, 100, 120, 0.2)' }
          }
        }
      }
    });
  }
};

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => {
    setTimeout(() => catacombsIntelPanel.init(), 1000);
  });
} else {
  setTimeout(() => catacombsIntelPanel.init(), 1000);
}
