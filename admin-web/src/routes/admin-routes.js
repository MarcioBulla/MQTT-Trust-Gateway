import { registerAuthRoutes } from './auth-routes.js';
import { registerGatewayRoutes } from './gateway-routes.js';

export function registerAdminRoutes(app) {
  registerAuthRoutes(app);
  registerGatewayRoutes(app);
}
