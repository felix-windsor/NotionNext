describe('Hobby-safe deployment defaults', () => {
  const originalEnv = { ...process.env }

  afterEach(() => {
    process.env = { ...originalEnv }
    jest.resetModules()
  })

  it('uses a multi-hour ISR interval unless explicitly configured', () => {
    delete process.env.NEXT_PUBLIC_REVALIDATE_SECOND
    jest.resetModules()

    const BLOG = require('@/blog.config')

    expect(Number(BLOG.NEXT_REVALIDATE_SECOND)).toBeGreaterThanOrEqual(3600)
  })

  it('enables cache reads in production unless explicitly disabled', () => {
    process.env.VERCEL_ENV = 'production'
    delete process.env.ENABLE_CACHE
    jest.resetModules()

    const config = require('@/conf/dev.config')

    expect(config.ENABLE_CACHE).toBe(true)
  })
})
