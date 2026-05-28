const express = require('express');
const { compileSchema } = require('../services/schemaCompiler');
const { inferSchema } = require('../utils/schemaInferer');

function createSchemasRouter(db) {
  const router = express.Router();

  router.get('/', async (req, res, next) => {
    try {
      const schemas = await db.schemas.getAll();

      const parsedSchemas = schemas.map(s => ({
        ...s,
        definition: JSON.parse(s.definition)
      }));

      res.json(parsedSchemas);
    } catch (err) {
      next(err);
    }
  });

  router.get('/:id', async (req, res, next) => {
    try {
      const schema = await db.schemas.getById(req.params.id);
      if (!schema) {
        return res.status(404).json({ error: 'Schema not found' });
      }
      
      res.json({
        ...schema,
        definition: JSON.parse(schema.definition)
      });
    } catch (err) {
      next(err);
    }
  });

  router.post('/', async (req, res, next) => {
    const { name, description, definition } = req.body;

    if (!name || !definition) {
      return res.status(400).json({ error: "Missing required fields: 'name' and 'definition' are mandatory." });
    }

    try {

      compileSchema(definition);

      const result = await db.schemas.insert({
        name,
        description: description || '',
        definition: JSON.stringify(definition)
      });

      res.status(201).json({
        message: 'Schema successfully compiled and registered.',
        schemaId: result.id
      });

    } catch (err) {
      
      res.status(400).json({
        error: 'Schema Validation Error',
        details: err.message
      });
    }
  });

  router.delete('/:id', async (req, res, next) => {
    try {
      const schema = await db.schemas.getById(req.params.id);
      if (!schema) {
        return res.status(404).json({ error: 'Schema not found' });
      }

      await db.schemas.delete(req.params.id);
      res.json({ message: 'Schema successfully unregistered.' });
    } catch (err) {
      next(err);
    }
  });

  router.post('/infer', (req, res) => {
    const { examples } = req.body;

    if (!examples || !Array.isArray(examples) || examples.length === 0) {
      return res.status(400).json({ error: "Missing 'examples'. Must provide an array of 1 to 5 sample JSON objects." });
    }

    try {
      const inferredDef = inferSchema(examples);
      
      res.json({
        message: 'Schema successfully inferred from examples.',
        inferredDefinition: inferredDef
      });
    } catch (err) {
      res.status(400).json({
        error: 'Inference Failure',
        details: err.message
      });
    }
  });

  return router;
}

module.exports = createSchemasRouter;
