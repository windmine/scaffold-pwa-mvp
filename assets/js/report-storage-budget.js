const MIB = 1024 * 1024;
const MAX_BYTES = Number.MAX_SAFE_INTEGER;
const DEFAULT_TIMEOUT_MS = 1500;

// These are conservative advisory policy thresholds, not measured device
// capacity. Estimates describe this browser origin's quota, not free disk space,
// and neither sufficient quota nor persistence makes a draft a guaranteed backup.
const LARGE_BATCH_BYTES = 20 * MIB;
const LARGE_REPORT_BYTES = 50 * MIB;
const LOW_AVAILABLE_BYTES = 50 * MIB;
const SAVE_OVERHEAD_BYTES = 20 * MIB;

function validBytes(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function boundedBytes(value) {
  return validBytes(value) ? Math.min(value, MAX_BYTES) : 0;
}

/** Size local originals without decoding, copying or allocating image bytes. */
export function reportEvidenceBytes(sources) {
  let bytes = 0;
  for (const source of Array.isArray(sources) ? sources : []) {
    if (typeof Blob !== 'undefined' && source instanceof Blob) {
      bytes = Math.min(MAX_BYTES, bytes + boundedBytes(source.size));
    } else if (typeof source === 'string' && /^data:/i.test(source)) {
      // Legacy evidence is a stored string. UTF-16 storage is a conservative
      // allowance larger than its decoded raster payload. Even a malformed
      // data: string occupies storage; evidence validation remains elsewhere.
      bytes = Math.min(MAX_BYTES, bytes + source.length * 2);
    }
    // Hosted URLs and temporary blob: URLs do not contain local photo bytes.
  }
  return bytes;
}

/** Advisory headroom for original evidence, a second draft/queue copy and writes. */
export function assessReportPhotoStorage({ estimate, incomingBytes = 0, existingBytes = 0 } = {}) {
  const incoming = boundedBytes(incomingBytes);
  const totalBytes = Math.min(MAX_BYTES, incoming + boundedBytes(existingBytes));
  const requiredBytes = Math.min(MAX_BYTES, 2 * totalBytes + SAVE_OVERHEAD_BYTES);
  let quota;
  let usage;
  // Browser results may be absent, malformed, or throw through a platform getter.
  try {
    quota = estimate?.quota;
    usage = estimate?.usage;
  } catch { /* An unreadable estimate is unknown, never zero remaining space. */ }
  const estimateKnown = validBytes(quota) && quota > 0 && validBytes(usage);
  const availableBytes = estimateKnown ? Math.max(0, quota - usage) : null;
  const large = incoming >= LARGE_BATCH_BYTES || totalBytes >= LARGE_REPORT_BYTES;
  let warning = null;
  if (estimateKnown && (availableBytes < LOW_AVAILABLE_BYTES
      || usage / quota >= 0.8 || availableBytes < requiredBytes)) {
    warning = 'low';
  } else if (large) {
    warning = estimateKnown ? 'large' : 'unknown';
  }
  return { warning, incomingBytes: incoming, totalBytes, availableBytes, requiredBytes, estimateKnown };
}

/** A bounded, read-only browser estimate; unsupported platforms remain usable. */
export async function estimateReportPhotoStorage(sources, existingSources, options = {}) {
  const incomingBytes = reportEvidenceBytes(sources);
  const existingBytes = reportEvidenceBytes(existingSources);
  let timer;
  let estimate;
  try {
    // Read defaults inside the try: navigator, storage and estimate can all have
    // throwing getters in denied/private environments. Do not request persist().
    const storage = Object.prototype.hasOwnProperty.call(options, 'storage')
      ? options.storage : globalThis.navigator?.storage;
    const readEstimate = storage?.estimate;
    if (typeof readEstimate === 'function') {
      const requestedTimeout = options.timeoutMs;
      const timeoutMs = validBytes(requestedTimeout) ? requestedTimeout : DEFAULT_TIMEOUT_MS;
      estimate = await Promise.race([
        Promise.resolve().then(() => readEstimate.call(storage)),
        new Promise((resolve) => { timer = setTimeout(() => resolve(undefined), timeoutMs); })
      ]);
    }
  } catch { /* No estimate must not be mistaken for proof of available storage. */ }
  finally { if (timer !== undefined) clearTimeout(timer); }
  return assessReportPhotoStorage({ estimate, incomingBytes, existingBytes });
}

/** Recognize quota failures without classifying unrelated storage/auth failures. */
export function isStorageQuotaError(error) {
  const seen = new Set();
  let current = error;
  for (let depth = 0; depth < 5 && current && typeof current === 'object'; depth += 1) {
    if (seen.has(current)) return false;
    seen.add(current);
    try {
      if (current.name === 'QuotaExceededError') return true; // DOMException code 22.
      if (current.name === 'NS_ERROR_DOM_QUOTA_REACHED' && current.code === 1014) return true;
      if (current.name === 'QUOTA_EXCEEDED_ERR' && current.code === 22) return true;
      current = current.cause;
    } catch { return false; }
  }
  return false;
}
