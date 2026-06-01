import { env } from '../../config.js';
import { publishMqttMessage, setMqttLastError } from './client.js';
import { clearObservedTopics, observedTopicNames } from './topic-store.js';

const maxTimerMs = 2147483647;
let cleanupTimer = null;
let nextCleanupAt = null;

function clampedMonthlyCleanupDay(year, month) {
  const configuredDay = Number.isFinite(env.mqttMonthlyCleanupDay) ? env.mqttMonthlyCleanupDay : 1;
  const day = Math.min(Math.max(Math.trunc(configuredDay), 1), 28);
  const lastDay = new Date(year, month + 1, 0).getDate();
  return Math.min(day, lastDay);
}

function clampedMonthlyCleanupHour() {
  const configuredHour = Number.isFinite(env.mqttMonthlyCleanupHour) ? env.mqttMonthlyCleanupHour : 3;
  return Math.min(Math.max(Math.trunc(configuredHour), 0), 23);
}

function nextMonthlyCleanupDate(now = new Date()) {
  const hour = clampedMonthlyCleanupHour();
  let year = now.getFullYear();
  let month = now.getMonth();
  let day = clampedMonthlyCleanupDay(year, month);
  let candidate = new Date(year, month, day, hour, 0, 0, 0);

  if (candidate <= now) {
    month += 1;
    if (month > 11) {
      month = 0;
      year += 1;
    }
    day = clampedMonthlyCleanupDay(year, month);
    candidate = new Date(year, month, day, hour, 0, 0, 0);
  }

  return candidate;
}

async function publishEmptyRetained(topicName) {
  await publishMqttMessage({ topic: topicName, payload: '', qos: 0, retain: true });
}

export async function runMonthlyMessageCleanup() {
  const topicNames = await observedTopicNames();

  for (const topicName of topicNames) {
    await publishEmptyRetained(topicName);
  }

  await clearObservedTopics();
}

function scheduleNextMonthlyCleanup() {
  if (!env.mqttMonthlyCleanupEnabled) return;

  const nextRun = nextMonthlyCleanupDate();
  nextCleanupAt = nextRun.toISOString();
  const delay = nextRun.getTime() - Date.now();

  cleanupTimer = setTimeout(async () => {
    cleanupTimer = null;
    if (delay > maxTimerMs) {
      scheduleNextMonthlyCleanup();
      return;
    }

    try {
      await runMonthlyMessageCleanup();
    } catch (error) {
      setMqttLastError(error);
    } finally {
      scheduleNextMonthlyCleanup();
    }
  }, Math.min(delay, maxTimerMs));
}

export function startMonthlyMessageCleanup() {
  if (cleanupTimer || !env.mqttMonthlyCleanupEnabled) return;
  scheduleNextMonthlyCleanup();
}

export function monthlyCleanupStatus() {
  return {
    monthlyCleanupEnabled: env.mqttMonthlyCleanupEnabled,
    nextMonthlyCleanupAt: nextCleanupAt,
  };
}
