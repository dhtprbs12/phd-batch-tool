/**
 * Cache Helper Utilities
 * Shared functions for per-condition caching strategy
 */

/**
 * Get condition hash for a single condition
 * Format: "{condition}_{productType}" e.g., "healthy_food", "diabetes_treats"
 * @param {string} condition - The health condition (or 'healthy' for no conditions)
 * @param {string} productType - 'food' or 'treats'
 * @returns {string} The condition hash
 */
function getSingleConditionHash(condition, productType) {
  if (!condition || condition === 'healthy') {
    return `healthy_${productType}`;
  }
  return `${condition}_${productType}`;
}

/**
 * Safe JSON parsing with fallback
 * @param {string|array} str - JSON string or array to parse
 * @param {*} fallback - Fallback value if parsing fails (default: [])
 * @returns {array} Parsed array or fallback
 */
function safeJsonParse(str, fallback = []) {
  if (!str) return fallback;
  if (Array.isArray(str)) return str;
  try {
    const parsed = JSON.parse(str);
    return Array.isArray(parsed) ? parsed : fallback;
  } catch {
    if (typeof str === 'string' && str.length > 0) {
      return [str];
    }
    return fallback;
  }
}

/**
 * Convert grade letter to numeric value for comparison
 * @param {string} grade - Grade letter (A, B, C, D, F)
 * @returns {number} Numeric value (A=4, B=3, C=2, D=1, F=0)
 */
function gradeToNumber(grade) {
  const grades = { 'A': 4, 'B': 3, 'C': 2, 'D': 1, 'F': 0 };
  return grades[grade] ?? 2;
}

/**
 * Convert numeric value to grade letter
 * @param {number} num - Numeric value
 * @returns {string} Grade letter
 */
function numberToGrade(num) {
  if (num >= 3.5) return 'A';
  if (num >= 2.5) return 'B';
  if (num >= 1.5) return 'C';
  if (num >= 0.5) return 'D';
  return 'F';
}

/**
 * Extract individual conditions from pet's health conditions
 * @param {array} healthConditions - Array of condition objects or strings
 * @returns {array} Array of condition type strings
 */
function extractConditionTypes(healthConditions) {
  if (!healthConditions || healthConditions.length === 0) {
    return ['healthy'];
  }
  return healthConditions.map(c => c.condition_type || c.conditionType || c);
}

/**
 * Check if a conditions_hash is using the old combined MD5 format
 * Old format: 16-char hex string (MD5 hash)
 * New format: "{condition}_{productType}" e.g., "healthy_food", "diabetes_treats"
 * @param {string} hash - The conditions hash to check
 * @returns {boolean} True if using old MD5 format
 */
function isOldMd5Hash(hash) {
  if (!hash || hash.length !== 16) return false;
  // Check if it's a hex string (old MD5 format)
  return /^[0-9a-f]{16}$/.test(hash);
}

module.exports = {
  getSingleConditionHash,
  safeJsonParse,
  gradeToNumber,
  numberToGrade,
  extractConditionTypes,
  isOldMd5Hash
};

