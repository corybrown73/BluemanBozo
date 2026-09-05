'use strict';

const express = require('express');
const odds = require('../odds');
const { requireAuth, requireAdmin } = require('../auth');
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

// Costs (markets x regions) credits on a cache miss.
router.get('/events/:eventId/props', async (req, res) => {
  try {
    const markets = req.query.markets ? String(req.query.markets).split(',') : null;
    const force = req.query.force === '1' && req.user.is_admin;
    const result = await odds.getEventProps(req.params.eventId, { markets, force });
    res.json({ ...result, quota: odds.quotaStatus() });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

// What a full-slate pull costs right now. Free — reads the cache, no API call.
router.get('/slate/estimate', async (req, res) => {
  try {
    const { events } = await odds.getEvents();
    const markets = req.query.markets ? String(req.query.markets).split(',') : null;
    res.json(odds.estimateSlate(events, markets));
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

// Every game's props in one board. Costs (uncached games x markets x regions).
router.get('/slate', async (req, res) => {
  try {
    const markets = req.query.markets ? String(req.query.markets).split(',') : null;
    const force = req.query.force === '1' && req.user.is_admin;
    const result = await odds.getSlateProps({ markets, force });
    res.json({ ...result, quota: odds.quotaStatus() });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
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
