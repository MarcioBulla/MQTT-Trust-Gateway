export function updatePreferences(settings = {}) {
  return {
    channel: settings.updateChannel === 'beta' ? 'beta' : 'stable',
    automaticChecks: settings.updateAutomaticChecks !== false,
    checkIntervalHours: [1, 6, 12, 24].includes(settings.updateCheckIntervalHours) ? settings.updateCheckIntervalHours : 6,
    snapshotRetention: Number.isInteger(settings.updateSnapshotRetention) && settings.updateSnapshotRetention >= 2 && settings.updateSnapshotRetention <= 100 ? settings.updateSnapshotRetention : 5,
    notifications: settings.updateNotifications !== false,
    automaticInstallation: false,
  };
}
export function applyUpdatePreferences(settings, input) {
  if (!input || !['stable', 'beta'].includes(input.channel)) throw Object.assign(new Error('Channel must be stable or beta'), { status: 400 });
  for (const key of ['automaticChecks', 'notifications']) {
    if (input[key] !== undefined && typeof input[key] !== 'boolean') throw Object.assign(new Error('Invalid update preferences'), { status: 400 });
  }
  if (input.checkIntervalHours !== undefined && ![1, 6, 12, 24].includes(input.checkIntervalHours)) throw Object.assign(new Error('Invalid update check interval'), { status: 400 });
  if (input.snapshotRetention !== undefined && (!Number.isInteger(input.snapshotRetention) || input.snapshotRetention < 2 || input.snapshotRetention > 100)) throw Object.assign(new Error('Snapshot retention must be between 2 and 100'), { status: 400 });
  settings.updateChannel = input.channel;
  if (input.automaticChecks !== undefined) settings.updateAutomaticChecks = input.automaticChecks;
  if (input.notifications !== undefined) settings.updateNotifications = input.notifications;
  if (input.checkIntervalHours !== undefined) settings.updateCheckIntervalHours = input.checkIntervalHours;
  if (input.snapshotRetention !== undefined) settings.updateSnapshotRetention = input.snapshotRetention;
  return updatePreferences(settings);
}
