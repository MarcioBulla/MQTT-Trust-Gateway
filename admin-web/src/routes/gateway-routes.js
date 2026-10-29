import { registerCertificateRoutes } from './certificate-routes.js';
import { registerMqttRoutes } from './mqtt-routes.js';
import { registerStatusRoutes } from './status-routes.js';
import { registerLogRoutes } from './log-routes.js';

export function registerGatewayRoutes(app) {
  registerStatusRoutes(app);
  registerLogRoutes(app);
  registerCertificateRoutes(app);
  registerMqttRoutes(app);
}
