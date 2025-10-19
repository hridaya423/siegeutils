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
    const match = coinStr.match(/(\d+\.?\d*)/);
    return match ? parseFloat(match[1]) : 0;
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
    if (!totalCoins || !hours) return { reviewerBonus: 1.0, avgVoterStars: 3.0 };

    const stats = this.getStoredStats();

    let baseRate;
    if (week <= 4) {
      baseRate = 2.0;
    } else {
      if (hours <= 10) {
        baseRate = 0.5;
      } else {
        baseRate = (10 * 0.5 + (hours - 10) * 2.0) / hours;
      }
    }

    const target = totalCoins / (baseRate * hours);
    const pastProjects = Object.values(stats).filter(p => p.week === week);
    let historicalRbAvg = 1.5;
    let historicalStarsAvg = 3.0;

    if (pastProjects.length > 0) {
      historicalRbAvg = pastProjects.reduce((sum, p) => sum + p.reviewer_bonus, 0) / pastProjects.length;
      historicalStarsAvg = pastProjects.reduce((sum, p) => sum + p.avg_score, 0) / pastProjects.length;
    }

    const validCombinations = [];
    const discreteVoterAverages = this.generateDiscreteVoterAverages();

    for (let rb = 1.0; rb <= 3.0; rb = Math.round((rb + 0.1) * 10) / 10) {
      for (const avgStars of discreteVoterAverages) {
        const calculatedTarget = rb * avgStars;
        const targetDeviation = Math.abs(calculatedTarget - target);

        if (targetDeviation / target < 0.25) {
          const rbBias = pastProjects.length > 0 ? historicalRbAvg : 1.5;
          const starsBias = pastProjects.length > 0 ? historicalStarsAvg : 3.0;

          const biasCorrection = (rb - rbBias) * 0.25 + (avgStars - starsBias) * 0.25;
          const adjustedDeviation = targetDeviation - biasCorrection;

          validCombinations.push({
            reviewerBonus: rb,
            avgVoterStars: avgStars,
            correlationDeviation: adjustedDeviation,
            targetDeviation: targetDeviation,
            quality: 1 / (targetDeviation + 0.01)
          });
        }
      }
    }

    if (validCombinations.length === 0) {
      return { reviewerBonus: 1.0, avgVoterStars: 3.0 };
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

    const finalReviewerBonus = Math.round(avgReviewerBonus * 10) / 10;
    const finalVoterStars = Math.round(avgVoterStars * 10) / 10;


    return {
      reviewerBonus: finalReviewerBonus,
      avgVoterStars: finalVoterStars
    };
  },

  calculateEfficiency(totalCoins, hours) {
    if (!hours) return 0;
    return totalCoins / hours;
  },


  async extractProjectData(projectCard) {
    const projectId = projectCard.id.replace('project_', '');
    const titleElement = projectCard.querySelector('.project-title');
    const badgeElement = projectCard.querySelector('.project-badge');
    const timeElement = projectCard.querySelector('.project-time');
    const valueElement = projectCard.querySelector('.project-status-indicator');

    if (!titleElement || !timeElement || !valueElement) {
      return null;
    }

    const title = titleElement.textContent.trim();
    const week = badgeElement ? this.parseWeek(badgeElement.textContent) : 1;
    const timeStr = timeElement.textContent.replace('Time spent: ', '');
    const hours = this.parseTimeString(timeStr);
    const valueStr = valueElement.textContent;
    const totalCoins = this.parseCoins(valueStr);

    if (!hours || hours === 0) {
      return null;
    }

    let stats = this.getStoredStats();

    let estimates = { avgVoterStars: 3.0, reviewerBonus: 2.0 };
    let coinsPerHour = 0;

    if (totalCoins > 0) {
      estimates = this.estimateReviewerAndVoterStats(totalCoins, week, hours);
      coinsPerHour = this.calculateEfficiency(totalCoins, hours);
    }

    const projectData = {
      projectId,
      title,
      week,
      hours,
      totalCoins,
      avgScore: estimates.avgVoterStars,
      reviewerBonus: estimates.reviewerBonus,
      coinsPerHour
    };

    if (totalCoins > 0) {
      stats[`project_${projectId}`] = {
        avg_score: estimates.avgVoterStars,
        reviewer_bonus: estimates.reviewerBonus,
        week: week,
        hours: parseFloat(hours.toFixed(2)),
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
            <div style="font-size: 1.1rem; font-weight: 600; margin-bottom: 0.25rem; color: #3b82f6;">
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

  async sideloadProjectTime(projectId) {
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
          this.trackProjectTime(projectId, hours, week);

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
        const timeString = todayElement.textContent.replace(/.*today you coded\s*/i, '').trim();
        if (/\d/.test(timeString)) {
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

    const remainingHours = Math.max(0, projectionData.totalHoursNeeded || 0);

    const daysRemaining = Math.max(1, timeline.daysRemaining || 1);
    const weeksRemaining = Math.max(1, timeline.weeksRemaining || 1);

    const targetDaily = remainingHours > 0 ? remainingHours / daysRemaining : 0;
    const targetWeekly = remainingHours > 0 ? remainingHours / weeksRemaining : 0;

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
              requiredItems.push({...item, category, device});
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
            <span style="font-size: 1.1rem; font-weight: 500; color: #3b82f6;">${projectionData.projectedPercentage}%</span>
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

    currentRouteItem = {
      item: enrichedItem,
      category: effectiveCategory,
      device: effectiveDevice
    };
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

    return {
      nodes,
      edges,
      totalCost,
      ownedCost,
      neededCost,
      targetTitle: targetItem.title,
      category,
      device
    };
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

      const titleY = hasCoinLine ? 42 : (nodeHeight / 2);
      const titleBaseline = hasCoinLine ? '' : 'dominant-baseline="middle"';
      const coinLine = hasCoinLine
        ? `<text x="${nodeWidth / 2}" y="${nodeHeight - 24}" class="siege-route-node-coins">${coinsText}</text>`
        : '';

      return `
        <g class="${classes.join(' ')}" transform="translate(${node.x}, ${node.y})">
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

    return `
      <div class="siege-route-summary-card">
        <div class="siege-route-summary-title">${title}</div>
        <div class="siege-route-summary-row"><span>Total</span><span>${totalText}</span></div>
        <div class="siege-route-summary-row"><span>Owned</span><span>${ownedText}</span></div>
        <div class="siege-route-summary-row"><span>Remaining</span><span>${neededText}</span></div>
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

    container.innerHTML = this.buildSvgDiagram(graph);
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
      userPurchases = purchases.purchases || [];
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
        <div class="siege-coins-display">${utils.formatCoins(userCoins)}</div>
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

  await routePlanner.renderCurrentRoute();
}

async function init() {
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

  const controlsHTML = `
    <div class="siege-project-controls" style="display: flex; gap: 0.5rem; align-items: center;">
      <select id="siege-sort" style="padding: 0.375rem 0.5rem; border-radius: 0.25rem; background: rgba(0, 0, 0, 0.3); border: 1px solid rgba(255, 255, 255, 0.2); color: inherit; font-size: 0.875rem;">
        <option value="default">Sort by...</option>
        <option value="hours-desc">Hours (Descending)</option>
        <option value="hours-asc">Hours (Ascending)</option>
        <option value="coins-desc">Coins (Descending)</option>
        <option value="coins-asc">Coins (Ascending)</option>
        <option value="efficiency-desc">Efficiency (Descending)</option>
      </select>
      <select id="siege-filter" style="padding: 0.375rem 0.5rem; border-radius: 0.25rem; background: rgba(0, 0, 0, 0.3); border: 1px solid rgba(255, 255, 255, 0.2); color: inherit; font-size: 0.875rem;">
        <option value="all">All Projects</option>
        <option value="shipped">Shipped</option>
        <option value="unshipped">Unshipped</option>
      </select>
    </div>
  `;

  projectsActions.insertAdjacentHTML('beforeend', controlsHTML);

  document.getElementById('siege-sort').addEventListener('change', applyProjectSort);
  document.getElementById('siege-filter').addEventListener('change', applyProjectFilter);
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

  projectCards.forEach(card => {
    const data = extractCardData(card);

    if (filterValue === 'all') {
      card.style.display = '';
    } else if (filterValue === 'shipped') {
      card.style.display = data.shipped ? '' : 'none';
    } else if (filterValue === 'unshipped') {
      card.style.display = !data.shipped ? '' : 'none';
    }
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
    const statusText = statusElement ? statusElement.textContent : '';
    const fallbackShipped = statusText.includes('🪙') || /\d+\.\d+/.test(statusText);

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

  return {
    hours: Number.isFinite(hours) ? hours : 0,
    coins: Number.isFinite(coins) ? coins : 0,
    efficiency: Number.isFinite(efficiency) ? efficiency : 0,
    shipped: Boolean(shipped),
    originalIndex: originalIndex >= 0 ? originalIndex : Number.MAX_SAFE_INTEGER
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
        const currentWeek = utils.getCurrentWeek();
        const statusElement = card.querySelector('.project-status-indicator');
        const statusText = statusElement ? statusElement.textContent : 'NO STATUS ELEMENT';
        const hasCoins = statusText.includes('🪙') ||
                         /Value:\s*\d+(\.\d+)?/.test(statusText) ||
                         /\d+\.\d+\s*🪙/.test(statusText) ||
                         statusText.includes('coin') ||
                         /\d+\s*coins?/i.test(statusText);

        const isUnshipped = !hasCoins;

        if (isUnshipped) {
          if (projectData.week === currentWeek) {
            const sideloadedHours = await projectStats.sideloadProjectTime(projectData.projectId);

            if (sideloadedHours && sideloadedHours > 0) {
              projectData.hours = sideloadedHours;
            }
          } else {
            projectStats.trackProjectTime(projectData.projectId, projectData.hours, projectData.week);
          }
        }

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
    const avgScoreElement = document.querySelector('.submit-button.submit-button--disabled');

    if (!timeElement || !valueElement || !titleElement || !avgScoreElement) {
      return;
    }

    const timeStr = timeElement.textContent.replace('Time spent: ', '');
    const hours = projectStats.parseTimeString(timeStr);
    const valueStr = valueElement.textContent;
    const totalCoins = projectStats.parseCoins(valueStr);
    const titleStr = titleElement.textContent;
    const week = projectStats.parseWeek(titleStr);

    const avgScoreMatch = avgScoreElement.textContent.match(/Avg\.\s*Score:\s*([\d.]+)/);
    const avgScore = avgScoreMatch ? parseFloat(avgScoreMatch[1]) : null;

    if (!hours || !totalCoins) {
      return;
    }

    const estimates = projectStats.estimateReviewerAndVoterStats(totalCoins, week, hours);
    const coinsPerHour = projectStats.calculateEfficiency(totalCoins, hours);
    const isUnshipped = totalCoins === 0;

    if (isUnshipped) {
      projectStats.trackProjectTime(projectId, hours, week);
    }

    const projectData = {
      projectId,
      week,
      hours,
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
      hours: hours,
      total_coins: totalCoins,
      coins_per_hour: coinsPerHour
    };
    projectStats.saveStats(stats);

    const detailedStats = projectStats.createDetailedStats(projectData);

    let projectionsHTML = '';
    if (isCurrentWeek && isUnshipped) {
      const unshippedHours = projectStats.getUnshippedTime(projectId);
      projectionsHTML = projectStats.createProjectProjections(projectId, unshippedHours, week);
    }

    const reviewerFeedback = document.querySelector('.reviewer-feedback-indicator') ||
                            document.querySelector('[class*="reviewer"]') ||
                            document.querySelector('[class*="feedback"]');

    let insertionPoint;
    if (reviewerFeedback) {
      insertionPoint = reviewerFeedback;
      insertionPoint.insertAdjacentHTML('beforebegin', detailedStats + projectionsHTML);
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

  } catch (error) {
    console.error('Failed to enhance project page:', error);
  }
}

async function initProjectStats() {
  if (window.location.pathname === '/armory') {
    await enhanceProjectCards();
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
    homeContainer.dataset.siegeEnhanced = 'true';

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
                  <span>Total pillaging since Week 1:</span>
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

        if (hasShippedData) {
          const totalWeekCoins = weekShippedProjects.reduce((sum, p) => sum + p.total_coins, 0);
          const totalWeekHours = weekShippedProjects.reduce((sum, p) => sum + p.hours, 0);
          coinsPerHour = totalWeekHours > 0 ? totalWeekCoins / totalWeekHours : 0;
          isCoinsProjected = false;
        } else {
          coinsPerHour = weekNum >= 5 ? goals.getWeek5PlusEfficiency() : projectStats.getAverageEfficiency();
          isCoinsProjected = true;
        }

        return {
          week: weekNum,
          hours: weekData.hours,
          coinsPerHour,
          label: `Week ${week}`,
          isProjected: isCoinsProjected,
          isCoinsProjected,
          isHoursProjected
        };
      });
    const avgEfficiency = projectStats.getAverageEfficiency();

    const futureWeek = currentWeek + 1;
    const futureWeekEfficiency = futureWeek >= 5 ? goals.getWeek5PlusEfficiency() : avgEfficiency;

    chartData.push({
      week: futureWeek,
      hours: chartData.length > 0 ? chartData[chartData.length - 1].hours * 0.9 : 8,
      coinsPerHour: futureWeekEfficiency,
      label: `Week ${futureWeek}`,  
      isProjected: true,
      isCoinsProjected: true,
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

    new Chart(ctx, {
      type: 'line',
      data: {
        labels,
        datasets: [
          {
            data: hoursData,
            borderColor: '#34d399',
            backgroundColor: 'rgba(52, 211, 153, 0.12)',
            borderWidth: 2,
            fill: false,
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
            backgroundColor: 'rgba(96, 165, 250, 0.12)',
            borderWidth: 2,
            fill: false,
            tension: 0.25,
            pointBackgroundColor: (ctx) => chartData[ctx.dataIndex]?.isCoinsProjected ? '#ffffff' : '#60a5fa',
            pointBorderColor: '#60a5fa',
            pointBorderWidth: 2,
            pointRadius: (ctx) => chartData[ctx.dataIndex]?.isCoinsProjected ? 4 : 5,
            pointHoverRadius: 7,
            yAxisID: 'y',
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
            title: {
              display: false
            },
            grid: {
              color: 'rgba(226, 232, 240, 0.6)'
            },
            ticks: {
              color: '#334155',
              font: {
                size: 11
              }
            },
            beginAtZero: false,
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
                const isHoursSeries = context.datasetIndex === 0;
                const suffix = (!isHoursSeries && meta.isCoinsProjected) ? ' (projected)' : '';
                const label = isHoursSeries ? 'Hours' : '🪙/h';
                const value = isHoursSeries
                  ? `${context.parsed.y.toFixed(1)}h`
                  : `${context.parsed.y.toFixed(2)} 🪙/h`;
                return `${label}: ${value}${suffix}`;
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
                  <div style="font-size: 0.7rem; color: #3b82f6; margin-top: 0.15rem;">
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

    const footer = document.querySelector('.home-progress-footer');
    if (footer) {
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

    countdownContainer.style.marginTop = '0.75rem';
    countdownContainer.style.fontSize = '1.3rem';
    countdownContainer.style.fontWeight = '500';
    countdownContainer.style.color = '#374151';
    countdownContainer.style.padding = '0.5rem';
    countdownContainer.style.background = 'linear-gradient(180deg, rgba(255, 252, 237, 0.6), rgba(245, 236, 210, 0.55))';
    countdownContainer.style.borderRadius = '8px';
    countdownContainer.style.border = '1px solid rgba(0, 0, 0, 0.05)';
    countdownContainer.style.marginLeft = '2rem'
    countdownContainer.innerHTML = `
        Next week in: <span id="time-till-next-week" style="font-weight: 700; color: #1f2937;"></span>
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

  async function enhanceShopPage() {
    if (window.location.pathname !== '/shop') return;

    const shopItems = await shopUtils.getShopItems();

    if (shopItems) {
      window.siegeUtilsShopItems = shopItems
    } 
  }

  function addCastleTooltips() {
    if (window.location.pathname !== '/castle') return;
    if (document.querySelector('.siege-castle-tooltip')) return;

    const tooltipStyle = document.createElement('style');
    tooltipStyle.textContent = `
      .siege-castle-tooltip {
        position: fixed;
        background: rgba(40, 30, 20, 0.95);
        color: #f5e7b7;
        padding: 0.5rem 1rem;
        border-radius: 0.5rem;
        font-size: 1rem;
        font-weight: 600;
        pointer-events: none;
        z-index: 10000;
        opacity: 0;
        transition: opacity 0.2s ease;
        border: 2px solid rgba(245, 231, 183, 0.3);
        box-shadow: 0 4px 12px rgba(0, 0, 0, 0.4);
      }
      .siege-castle-tooltip.visible {
        opacity: 1;
      }
    `;
    document.head.appendChild(tooltipStyle);

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
        }

        if (window.location.pathname === '/shop') {
          enhanceShopPage();
        }

        if (window.location.pathname === '/castle') {
          addCastleTooltips();
        }

        initProjectStats();
        initKeepEnhancements();
        navigationTimeout = null;
      }, 300);
    }
  }

  document.addEventListener('turbo:load', handleNavigation);
  document.addEventListener('turbo:render', handleNavigation);
  document.addEventListener('turbo:visit', handleNavigation);
  document.addEventListener('turbo:frame-load', handleNavigation);

  document.addEventListener('turbolinks:load', handleNavigation);
  document.addEventListener('turbolinks:render', handleNavigation);
  document.addEventListener('turbolinks:visit', handleNavigation);

  new MutationObserver(handleNavigation).observe(document.body, { childList: true, subtree: true });
  window.addEventListener('popstate', handleNavigation);

  const originalPushState = history.pushState;
  const originalReplaceState = history.replaceState;

  history.pushState = function() {
    originalPushState.apply(history, arguments);
    setTimeout(handleNavigation, 50);
  };

  history.replaceState = function() {
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

  if (theme === 'catppuccin' || theme === 'custom') { 
    if (!existingThemeLink) {
      const link = document.createElement('link');
      link.id = 'siege-utils-theme';
      link.rel = 'stylesheet';
      link.href = browserAPI.runtime.getURL('catppuccin.css');
      document.head.appendChild(link);
    }

    if (theme === 'custom') {
      applyCustomColors(customColors);
      applyCustomHue(customHue);
    } else {
      if (existingCustomStyle) existingCustomStyle.remove();
      if (existingHueStyle) existingHueStyle.remove();
    }

    toggleHues(disableHues);
  } else {
    if (existingThemeLink) existingThemeLink.remove();
    if (existingCustomStyle) existingCustomStyle.remove();
    if (existingHueStyle) existingHueStyle.remove();
    document.body.classList.remove('no-hues');
  }
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

function initSimpleVotingInterface() {
  if (!window.location.pathname.includes('great-hall')) {
    return;
  }

  function extractVotingData() {
    const scripts = document.querySelectorAll('script');
    let votesData = null;
    let ballotId = null;

    for (const script of scripts) {
      const content = script.textContent;

      if (content && (content.includes('const votes =') || content.includes('votingManager.votes ='))) {
        const votesMatch = content.match(/(?:const votes|votingManager\.votes)\s*=\s*(\[[\s\S]*?\]);/);
        if (votesMatch) {
          try {
            votesData = JSON.parse(votesMatch[1]);
          } catch (e) {
            console.error('[Siege Utils] Failed to parse votes data:', e);
          }
        }

        if (!ballotId) {
          const scriptMatch = content.match(/const\s+currentBallotId\s*=\s*(\d+)/);
          if (scriptMatch) {
            ballotId = parseInt(scriptMatch[1]);
          }
        }
      }
    }

    if (!ballotId) {
      const urlMatch = window.location.pathname.match(/\/great-hall\/(\d+)/);
      if (urlMatch) {
        ballotId = parseInt(urlMatch[1]);
      }
    }

    if (!ballotId && votesData && votesData.length > 0) {
      if (votesData[0].ballot_id) {
        ballotId = votesData[0].ballot_id;
      } else if (votesData[0].ballotId) {
        ballotId = votesData[0].ballotId;
      }
    }

    return { votes: votesData, ballotId };
  }

  let { votes: votesData, ballotId } = extractVotingData();

  if (votesData) {
    if (!votesData || votesData.length === 0) {
      showVotingFinishedMessage();
      return;
    }

    createVotingInterface(votesData, ballotId);
  } else {
    let attempts = 0;
    const checkInterval = setInterval(() => {
      attempts++;

      if (attempts > 30) {
        clearInterval(checkInterval);
        showVotingFinishedMessage();
        return;
      }

      const result = extractVotingData();
      votesData = result.votes;
      ballotId = result.ballotId;

      if (votesData) {
        clearInterval(checkInterval);

        if (!votesData || votesData.length === 0) {
          showVotingFinishedMessage();
          return;
        }

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
        margin: 0;
        line-height: 1.6;
      ">Voting for this week has concluded. Check back next week to vote on new projects!</p>
    </div>
  `;

  appMain.appendChild(messageContainer);
}

function createVotingInterface(votes, ballotId) {

    const canvas = document.getElementById('voting-canvas');
    if (canvas) {
      canvas.style.display = 'none';
    }

    const uiOverlay = document.querySelector('.ui-overlay');
    if (uiOverlay) {
      uiOverlay.style.display = 'none';
    }
    const appMain = document.querySelector('.app-main');
    if (!appMain) {
      return;
    }

    appMain.innerHTML = '';

    const votingContainer = document.createElement('div');
    votingContainer.id = 'siege-simple-voting';
    votingContainer.style.cssText = `
      padding: 2rem;
      padding-left: 22rem;
      max-width: 1800px;
      margin: 0 auto;
      position: relative;
      z-index: 10000;
      min-height: 100vh;
      display: block !important;
      visibility: visible !important;
    `;

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
    votes.forEach(vote => {
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

        <div class="siege-project-links">
          ${vote.project.repo_url ? `<a href="${vote.project.repo_url}" target="_blank" class="siege-project-link">View Code</a>` : ''}
          ${vote.project.demo_url ? `<a href="${vote.project.demo_url}" target="_blank" class="siege-project-link">Play Project</a>` : ''}
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

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initSimpleVotingInterface);
} else {
  initSimpleVotingInterface();
}
