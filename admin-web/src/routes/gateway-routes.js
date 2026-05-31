import { registerCertificateRoutes } from './certificate-routes.js';
import { registerMqttRoutes } from './mqtt-routes.js';
import { registerStatusRoutes } from './status-routes.js';

export function registerGatewayRoutes(app) {
  registerStatusRoutes(app);
  registerCertificateRoutes(app);
  registerMqttRoutes(app);
}
