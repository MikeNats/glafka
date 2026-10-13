import net from 'node:net';

interface PortRange {
  start: number;
  end: number;
}

const DEFAULT_RANGE: PortRange = { start: 4100, end: 4199 };

// Tests a port by really binding it, then lets it go. We bind 0.0.0.0, not
// just localhost, so a port used elsewhere is not called free.
function isFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once('error', () => resolve(false));
    server.listen({ port, host: '0.0.0.0', exclusive: true }, () => {
      server.close(() => resolve(true));
    });
  });
}

// Starts at a random port, not always the first one,
// so two runs at the same time do not fight over it.
export async function findFreePort(
  { start, end }: PortRange = DEFAULT_RANGE,
  { skip = [] }: { skip?: number[] } = {},
): Promise<number> {
  const size = end - start + 1;
  const taken = new Set(skip);
  const from = Math.floor(Math.random() * size);

  for (let offset = 0; offset < size; offset++) {
    const port = start + ((from + offset) % size);
    if (taken.has(port)) continue;
    if (await isFree(port)) return port;
  }

  throw new Error(
    `no free port in ${start}-${end} — close some tickets, or widen portRange in .glafka.json`,
  );
}

export type { PortRange };
