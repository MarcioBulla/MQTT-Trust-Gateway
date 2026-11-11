// MQTT ACL patterns are line based: reject whitespace and control characters so
// an administrator-supplied filter cannot introduce additional ACL directives.
export function normalizeTopicRules(value) {
  if (!value || !['all', 'custom'].includes(value.mode)) throw Object.assign(new Error('Select a valid rules mode'), { status: 400 });
  if (value.mode === 'all') return { mode: 'all', publish: [], subscribe: [] };
  const filters = (list) => {
    if (!Array.isArray(list) || list.length > 100) throw Object.assign(new Error('Provide up to 100 topic filters per direction'), { status: 400 });
    const unique = new Set();
    for (const filter of list) {
      if (typeof filter !== 'string' || !filter || Buffer.byteLength(filter, 'utf8') > 512 || /[\s\x00-\x1f\x7f]/u.test(filter))
        throw Object.assign(new Error('Invalid topic filter'), { status: 400 });
      const levels = filter.split('/');
      if (levels.some((level, i) => (level.includes('#') && (level !== '#' || i !== levels.length - 1)) || (level.includes('+') && level !== '+')))
        throw Object.assign(new Error('Wildcards must occupy a complete topic level and # must be last'), { status: 400 });
      unique.add(filter);
    }
    return [...unique];
  };
  return { mode: 'custom', publish: filters(value.publish), subscribe: filters(value.subscribe) };
}

export function topicRulesForDevice(device) {
  if (device.topicRules === undefined) return { mode: 'all', publish: [], subscribe: [] };
  try { return normalizeTopicRules(device.topicRules); }
  catch { return { mode: 'custom', publish: [], subscribe: [] }; }
}

export function deviceAcl(device) {
  const rules = topicRulesForDevice(device);
  if (rules.mode === 'all') return `\nuser ${device.id}\ntopic readwrite #\n`;
  return `\nuser ${device.id}\n${rules.publish.map((filter) => `topic write ${filter}\n`).join('')}${rules.subscribe.map((filter) => `topic read ${filter}\n`).join('')}`;
}
