const express = require('express');
const { executeValidatedCall } = require('../services/schemaEnforcer');

function createCallsRouter(db) {
  const router = express.Router();

  router.post('/call', async (req, res) => {
    const {
      schemaId,
      schemaName,
      prompt,
      strategy = 'json_instruction',
      model = 'gemini-1.5-flash',
      variables = {},
      provider = 'mock',
      apiKey = null
    } = req.body;

    if (!prompt) {
      return res.status(400).json({ error: "Missing required field: 'prompt' is mandatory." });
    }

    if (!schemaId && !schemaName) {
      return res.status(400).json({ error: "Must specify 'schemaId' or 'schemaName' to identify the validator." });
    }

    try {
      
      let schema;
      if (schemaId) {
        schema = await db.schemas.getById(schemaId);
      } else {
        schema = await db.schemas.getByName(schemaName);
      }

      if (!schema) {
        return res.status(404).json({ error: `Schema not found with identifier: ${schemaId || schemaName}` });
      }

      const result = await executeValidatedCall({
        schema,
        prompt,
        variables,
        strategy,
        model,
        provider,
        db,
        apiKey
      });

      res.json(result);

    } catch (err) {
      
      if (err.isValidationError) {
        console.warn(`[API] Validated LLM Call failed validation: ${err.message}`);
        return res.status(422).json(err.payload);
      }

      console.error('[API] Unexpected enforcer execution crash:', err);
      res.status(500).json({
        error: 'Execution Engine Failure',
        details: err.message
      });
    }
  });

  router.get('/calls', async (req, res, next) => {
    try {
      const calls = await db.calls.getAll();
      
      const parsedCalls = calls.map(c => ({
        ...c,
        success: !!c.success,
        final_output: c.final_output ? JSON.parse(c.final_output) : null,
        token_usage: c.token_usage ? JSON.parse(c.token_usage) : null
      }));

      res.json(parsedCalls);
    } catch (err) {
      next(err);
    }
  });

  router.get('/calls/:id', async (req, res, next) => {
    try {
      const call = await db.calls.getById(req.params.id);
      if (!call) {
        return res.status(404).json({ error: 'Validation call log not found' });
      }

      const formattedCall = {
        ...call,
        success: !!call.success,
        final_output: call.final_output ? JSON.parse(call.final_output) : null,
        token_usage: call.token_usage ? JSON.parse(call.token_usage) : null,
        logs: (call.logs || []).map(l => ({
          ...l,
          response_received: l.response_received
        }))
      };

      res.json(formattedCall);
    } catch (err) {
      next(err);
    }
  });

  router.get('/failures', async (req, res, next) => {
    try {
      const failures = await db.calls.getFailures();
      res.json(failures);
    } catch (err) {
      next(err);
    }
  });

  router.get('/metrics', async (req, res, next) => {
    try {
      const metrics = await db.calls.getMetrics();
      res.json(metrics);
    } catch (err) {
      next(err);
    }
  });

  return router;
}

module.exports = createCallsRouter;
