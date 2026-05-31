import express from 'express';
import helmet from 'helmet';
import { env } from './config.js';
import { renderAdminPage } from './pages/admin-page.js';
import { registerAdminRoutes } from './routes/admin-routes.js';

const app = express();

app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'"],
      styleSrc: ["'self'"],
      fontSrc: ["'self'"],
      connectSrc: ["'self'"],
      imgSrc: ["'self'", 'data:'],
    },
  },
}));
app.use(express.json({ limit: '256kb' }));
app.use('/assets', express.static(new URL('./assets', import.meta.url).pathname, { maxAge: '7d' }));

app.get('/', (_req, res) => {
  res.type('html').send(renderAdminPage());
});

registerAdminRoutes(app);

app.use((error, _req, res, _next) => {
  res.status(500).json({ error: error.message });
});

app.listen(env.port, env.host, () => {
  console.log(`MQTT Trust Gateway admin listening on ${env.host}:${env.port}`);
});
