import { createApp } from 'vue';
import { createVuetify } from 'vuetify';
import * as components from 'vuetify/components';
import * as directives from 'vuetify/directives';
import { createRouter, createWebHashHistory } from 'vue-router';
import 'vuetify/styles';
import '@mdi/font/css/materialdesignicons.css';
import App from './App.vue';
import Dashboard from './pages/Dashboard.vue';
import Devices from './pages/Devices.vue';
import Identities from './pages/Identities.vue';
import Certificates from './pages/Certificates.vue';
import Mqtt from './pages/Mqtt.vue';
import Account from './pages/Account.vue';
const routes = [
  { path: '/', component: Dashboard },
  { path: '/devices', component: Identities },
  { path: '/devices/:deviceId/certificates', component: Certificates, props: (route) => ({ deviceId: String(route.params.deviceId) }) },
  { path: '/certificates', redirect: { path: '/devices', query: { view: 'certificates' } } },
  { path: '/licenses', component: Devices, props: { licenses: true } },
  { path: '/mqtt', component: Mqtt },
  { path: '/account', component: Account },
];
createApp(App)
  .use(
    createVuetify({
      components,
      directives,
      theme: {
        defaultTheme:
          localStorage.getItem('theme') ||
          (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'),
      },
      defaults: {
        VTextField: { variant: 'outlined', density: 'comfortable' },
        VTextarea: { variant: 'outlined' },
        VCard: { rounded: 'lg', variant: 'flat', border: true },
        VBtn: { rounded: 'lg' },
      },
    }),
  )
  .use(createRouter({ history: createWebHashHistory(), routes }))
  .mount('#app');
