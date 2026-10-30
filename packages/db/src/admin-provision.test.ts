import { describe, expect, it, vi } from 'vitest'
import { type AdminProvisionIo, choosePassword, deliverPassword } from './admin-provision.js'

function makeIo() {
  const lines: string[] = []
  const putSsm = vi.fn(async (email: string) => `/clickroom/admin/users/${email}/password`)
  const io: AdminProvisionIo = { log: (l) => lines.push(l), putSsm }
  return { io, lines, putSsm }
}

describe('admin password sink selection', () => {
  it('stdout prints the password once and never calls SSM', async () => {
    const { io, lines, putSsm } = makeIo()
    await deliverPassword('stdout', { email: 'a@b.co', password: 'secret-pw', verb: 'created' }, io)
    expect(lines.join('\n')).toContain('secret-pw')
    expect(putSsm).not.toHaveBeenCalled()
  })

  it('ssm stores the password and never prints it', async () => {
    const { io, lines, putSsm } = makeIo()
    await deliverPassword('ssm', { email: 'a@b.co', password: 'secret-pw', verb: 'created' }, io)
    expect(putSsm).toHaveBeenCalledWith('a@b.co', 'secret-pw')
    expect(lines.join('\n')).not.toContain('secret-pw')
  })

  it('env neither prints nor stores the password', async () => {
    const { io, lines, putSsm } = makeIo()
    await deliverPassword('env', { email: 'a@b.co', password: 'secret-pw', verb: 'created' }, io)
    expect(putSsm).not.toHaveBeenCalled()
    expect(lines.join('\n')).not.toContain('secret-pw')
  })

  it('an ssm failure propagates so the CLI can tell the operator to --rotate', async () => {
    const { io } = makeIo()
    io.putSsm = async () => {
      throw new Error('AccessDenied')
    }
    await expect(
      deliverPassword('ssm', { email: 'a@b.co', password: 'x', verb: 'created' }, io),
    ).rejects.toThrow('AccessDenied')
  })

  it('env sink requires a long-enough CLICKROOM_ADMIN_PASSWORD; other sinks generate one', () => {
    expect(() => choosePassword('env')).toThrow(/CLICKROOM_ADMIN_PASSWORD/)
    expect(() => choosePassword('env', 'short')).toThrow(/at least/)
    expect(choosePassword('env', 'a-long-enough-password')).toBe('a-long-enough-password')
    const generated = choosePassword('stdout', 'ignored')
    expect(generated).not.toBe('ignored')
    expect(generated).toHaveLength(32)
  })
})
