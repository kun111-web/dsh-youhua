// Simulate a durable domain by round-tripping every write through JSON.
export function storageFixture() {
  const disk = new Map(); let opened = 0, closed = 0, active = false;
  const facility = { async open(spec) {
    if (active) throw Error('already-open');
    active = true; opened++;
    let zone = disk.get('zone') ?? spec.global.initial;
    const records = new Map([...disk].filter(([key]) => key !== 'zone').map(([key, value]) => [key, spec.tables.sessions.valueSchema.parse(JSON.parse(value))]));
    return {
      global: { get: () => zone, set: async value => { zone = value; disk.set('zone', value); } },
      table: () => ({ get: id => records.get(id), entries: () => records.entries(), put: async (id, value) => {
        const json = JSON.stringify(value); disk.set(id, json); records.set(id, JSON.parse(json));
      } }),
      close: async () => { active = false; closed++; },
    };
  } };
  return { facility, disk, opened: () => opened, closed: () => closed };
}
