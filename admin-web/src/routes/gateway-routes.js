import { guardSensitiveApi } from '../sensitive-access.js';
import { registerSensitiveRoutes } from './sensitive-routes.js';
import { registerCertificateRoutes } from './certificate-routes.js';
import { registerMqttRoutes } from './mqtt-routes.js';
import { registerStatusRoutes } from './status-routes.js';
import { registerLogRoutes } from './log-routes.js';
import { registerUpdateRoutes } from './update-routes.js';

export function registerGatewayRoutes(app) {
  registerSensitiveRoutes(app);
  app.use('/api', guardSensitiveApi);
  registerStatusRoutes(app);
  registerLogRoutes(app);
  registerUpdateRoutes(app);
  registerCertificateRoutes(app);
  registerMqttRoutes(app);
}
