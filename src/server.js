require('dotenv').config();
const express = require('express');
const cors = require('cors');
const morgan = require('morgan');
const path = require('path');

const { initializeDatabase } = require('./db/connection');
const createSchemasRouter = require('./routes/schemas');
const createCallsRouter = require('./routes/calls');

const app = express();
const PORT = process.env.PORT || 3000;

console.log(`
████████╗██╗   ██╗██████╗ ███████╗ ██████╗ █████╗ ███████╗████████╗    █████╗ ██╗
╚══██╔══╝╚██╗ ██╔╝██╔══██╗██╔════╝██╔════╝██╔══██╗██╔════╝╚══██╔══╝   ██╔══██╗██║
   ██║    ╚████╔╝ ██████╔╝█████╗  ██║     ███████║███████╗   ██║      ███████║██║
   ██║     ╚██╔╝  ██╔═══╝ ██╔══╝  ██║     ██╔══██║╚════██║   ██║      ██╔══██║██║
   ██║      ██║   ██║     ███████╗╚██████╗██║  ██║███████║   ██║   ██╗██║  ██║██║
   ╚═╝      ╚═╝   ╚═╝     ╚══════╝ ╚═════╝╚═╝  ╚═╝╚══════╝   ╚═╝   ╚═╝╚═╝  ╚═╝╚═╝
              [ Schema Enforcer & Validated LLM Gateway Middleware ]
`);

async function bootstrap() {
  try {
    
    const db = await initializeDatabase();

    app.use(cors());
    app.use(express.json());

    app.use(morgan(':method :url :status :res[content-length] - :response-time ms'));

    app.use(express.static(path.join(__dirname, '../public')));

    app.use('/api/schemas', createSchemasRouter(db));
    app.use('/api', createCallsRouter(db));

    app.get('*', (req, res, next) => {
      
      if (req.url.startsWith('/api')) {
        return res.status(404).json({ error: `API route not found: ${req.method} ${req.url}` });
      }
      res.sendFile(path.join(__dirname, '../public/index.html'));
    });

    app.use((err, req, res, next) => {
      console.error('[Global Error Capture]:', err);
      res.status(500).json({
        error: 'Internal Server Error',
        message: process.env.NODE_ENV === 'development' ? err.message : 'An unexpected error occurred inside the gateway engine.',
        stack: process.env.NODE_ENV === 'development' ? err.stack : undefined
      });
    });

    app.listen(PORT, () => {
      console.log(`[TypeCast Ready] Server successfully bound and running at:`);
      console.log(`  └─ Local:   http://localhost:${PORT}`);
      console.log(`  └─ Environment: ${process.env.NODE_ENV || 'development'}`);
      console.log(`  └─ Press CTRL+C to terminate gateway session\n`);
    });

  } catch (initErr) {
    console.error('[TypeCast Boot Crash] Fatal boot failure during initialization:', initErr);
    process.exit(1);
  }
}

bootstrap();
