import {createApp} from 'vue';
import App from './App.vue';

const shell = document.documentElement.cloneNode(true);
for (const id of ['server-config', 'embedded-rollout']) shell.querySelector(`#${id}`)?.remove();

function createReport(rollout, theme) {
  const report = shell.cloneNode(true);
  report.dataset.theme = theme;
  const data = document.createElement('script');
  data.id = 'embedded-rollout';
  data.type = 'application/json';
  data.textContent = globalThis.AgentReplay.json(rollout);
  report.querySelector('body').prepend(data);
  return '<!doctype html>\n' + report.outerHTML;
}

const bootData = {};
const warnings = [];
for (const [key, id] of Object.entries({server: 'server-config', rollout: 'embedded-rollout'})) {
  const data = document.getElementById(id);
  if (!data) continue;
  try { bootData[key] = JSON.parse(data.textContent); }
  catch (error) { warnings.push(error.message); }
}
bootData.bootError = warnings.join('\n');
createApp(App, {bootData, createReport}).mount('#app');
