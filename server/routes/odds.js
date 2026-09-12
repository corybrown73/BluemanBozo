'use strict';

const express = require('express');
const odds = require('../odds');
const altlines = require('../altlines');
const roster = require('../roster');
const { requireAuth, requireAdmin } = require('../auth');
const refresh = require('../refresh');
const { currentWeek } = require('../db');
const { getSetting } = require('../db');

const router = express.Router();
router.use(requireAuth);

router.get('/markets', (req, res) => {
  const enabled = new Set((getSetting('odds_markets') || '').split(',').map((s) => s.trim()));
  res.json({
    markets: odds.MARKETS.map((m) => ({ ...m, enabled: enabled.has(m.key) })),
    quota: odds.quotaStatus(),
  });
});

router.get('/quota', (req, res) => {
  res.json(odds.quotaStatus());
});

// Free endpoint — zero credits. Refresh away.
router.get('/events', async (req, res) => {
  try {
    const force = req.query.force === '1' && req.user.is_admin;
    const result = await odds.getEvents({ force });
    res.json({ ...result, quota: odds.quotaStatus() });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

/** Only the commissioner may widen the market list — it multiplies the credit cost. */
function requestedMarkets(req) {
  if (!req.user.is_admin || !req.query.markets) return null;
  return String(req.query.markets).split(',');
}

// Costs (markets x regions) credits on a cache miss — and only the
// commissioner is allowed to incur that. Members read the cache.
router.get('/events/:eventId/props', async (req, res) => {
  try {
    const markets = requestedMarkets(req);
    const force = req.query.force === '1' && req.user.is_admin;
    const result = await odds.getEventProps(req.params.eventId, {
      markets, force, cacheOnly: !req.user.is_admin,
    });
    const tagged = await roster.tagProps(result.props);
    res.json({ ...result, roster_available: tagged.roster_available, quota: odds.quotaStatus() });
  } catch (err) {
    if (err.message === 'NOT_LOADED') {
      return res.status(409).json({ error: "This week's board hasn't been pulled yet.", not_loaded: true });
    }
    res.status(err.status || 500).json({ error: err.message });
  }
});

// What a full-slate pull costs right now. Free — reads the cache, no API call.
router.get('/slate/estimate', async (req, res) => {
  try {
    const { events } = await odds.getEvents();
    const markets = requestedMarkets(req);
    res.json(odds.estimateSlate(events, markets));
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

// Every game's props in one board. Costs (uncached games x markets x regions),
// so members are served from the cache and never trigger a paid pull.
router.get('/slate', async (req, res) => {
  try {
    const markets = requestedMarkets(req);
    const force = req.query.force === '1' && req.user.is_admin;
    const result = await odds.getSlateProps({ markets, force, cacheOnly: !req.user.is_admin });
    const tagged = await roster.tagProps(result.props);
    const wk = currentWeek();
    res.json({
      ...result,
      roster_available: tagged.roster_available,
      quota: odds.quotaStatus(),
      refresh: refresh.status(wk?.id, req.user),
    });
  } catch (err) {
    if (err.message === 'NOT_LOADED') {
      return res.status(409).json({
        error: "This week's board hasn't been pulled yet.",
        not_loaded: true,
      });
    }
    res.status(err.status || 500).json({ error: err.message });
  }
});

/**
 * Pull fresh lines on demand, out of the asker's own weekly allowance.
 *
 * The board is shared, so this updates it for everybody — which is the point.
 * The commissioner is not metered; they are the one watching the bill.
 */
router.post('/refresh', async (req, res) => {
  const wk = currentWeek();
  const before = refresh.status(wk?.id, req.user);
  if (!before.can) {
    return res.status(429).json({ error: before.reason, refresh: before });
  }

  try {
    const result = await odds.getSlateProps({ markets: requestedMarkets(req), force: true });
    // Only bill the allowance for a pull that actually cost something. A
    // cache hit is not worth one of somebody's two — and neither is a pull
    // that fell back to old numbers because the provider was down.
    if (result.cost > 0) {
      refresh.record(wk.id, req.user.id, { source: 'member', credits: result.cost });
    }
    const tagged = await roster.tagProps(result.props);
    res.json({
      ...result,
      roster_available: tagged.roster_available,
      quota: odds.quotaStatus(),
      refresh: refresh.status(wk.id, req.user),
    });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

/**
 * Price a ladder of alternate lines around a posted prop. Pure maths on numbers
 * the client already has — costs zero credits and never touches the provider.
 */
router.get('/curve', (req, res) => {
  const anchor = {
    market: String(req.query.market || ''),
    line: Number(req.query.line),
    selection: String(req.query.selection || 'Over'),
    price: Number(req.query.price),
    opposite_price: req.query.opposite_price === undefined ? undefined : Number(req.query.opposite_price),
  };
  if (!anchor.market || !Number.isFinite(anchor.line) || !Number.isFinite(anchor.price)) {
    return res.status(400).json({ error: 'Need market, line and price to build a curve.' });
  }
  const curve = altlines.curveFor(anchor);
  if (!curve) return res.status(400).json({ error: 'That market has no line to slide.' });
  res.json(curve);
});

router.get('/scores', requireAdmin, async (req, res) => {
  try {
    const result = await odds.getScores({
      daysFrom: Math.min(3, parseInt(req.query.daysFrom, 10) || 3),
      force: req.query.force === '1',
    });
    res.json({ ...result, quota: odds.quotaStatus() });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

module.exports = router;
