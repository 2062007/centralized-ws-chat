// Rate limiter đơn giản trong bộ nhớ (cửa sổ trượt cố định)
function createLimiter(max, windowMs) {
  const hits = new Map();
  setInterval(() => {
    const now = Date.now();
    for (const [k, v] of hits) if (v.reset <= now) hits.delete(k);
  }, windowMs).unref();

  return function allow(key) {
    const now = Date.now();
    let e = hits.get(key);
    if (!e || e.reset <= now) {
      e = { count: 0, reset: now + windowMs };
      hits.set(key, e);
    }
    e.count++;
    return e.count <= max;
  };
}

function expressLimiter(max, windowMs, message = 'Too many requests') {
  const allow = createLimiter(max, windowMs);
  return (req, res, next) => (allow(req.ip) ? next() : res.status(429).json({ error: message }));
}

module.exports = { createLimiter, expressLimiter };
