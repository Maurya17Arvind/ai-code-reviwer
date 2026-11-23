import { createRedisConnectionOptions } from './redis-connection';

describe('createRedisConnectionOptions', () => {
  it('parses host, port, password and db', () => {
    const options = createRedisConnectionOptions('redis://:p%40ss@cache.internal:6380/2', 'producer');
    expect(options).toMatchObject({ host: 'cache.internal', port: 6380, db: 2, password: 'p@ss' });
    expect(options).not.toHaveProperty('username');
    expect(options).not.toHaveProperty('tls');
  });

  it('defaults port and db', () => {
    expect(createRedisConnectionOptions('redis://localhost', 'producer')).toMatchObject({ port: 6379, db: 0 });
  });

  it('enables TLS for rediss://', () => {
    const options = createRedisConnectionOptions('rediss://user:pw@redis.example.com:6379/0', 'worker');
    expect(options.tls).toEqual({ servername: 'redis.example.com' });
    expect(options.username).toBe('user');
  });

  it('configures workers for blocking commands and producers to fail fast', () => {
    expect(createRedisConnectionOptions('redis://localhost', 'worker').maxRetriesPerRequest).toBeNull();
    const producer = createRedisConnectionOptions('redis://localhost', 'producer');
    expect(producer.maxRetriesPerRequest).toBe(1);
    expect(producer.enableOfflineQueue).toBe(false);
  });

  it('rejects other schemes and invalid db indexes without echoing the URL', () => {
    expect(() => createRedisConnectionOptions('http://:secret@localhost', 'producer')).toThrow(/redis:\/\//);
    expect(() => createRedisConnectionOptions('redis://:secret@localhost/abc', 'producer')).toThrow(/database index/);
    try {
      createRedisConnectionOptions('http://:secret@localhost', 'producer');
    } catch (error) {
      expect((error as Error).message).not.toContain('secret');
    }
  });
});
