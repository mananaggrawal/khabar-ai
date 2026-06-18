import { createMiddleware } from '@tanstack/react-start'
import { supabase } from './client'

export const attachSupabaseAuth = createMiddleware({ type: 'function' }).client(
  async ({ next }) => {
    // LOCAL_MODE: send a dummy token — the server middleware ignores it
    if (import.meta.env.VITE_LOCAL_MODE === 'true') {
      return next({ headers: { Authorization: 'Bearer local-dev' } })
    }
    const { data } = await supabase.auth.getSession()
    const token = data.session?.access_token
    return next({
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    })
  },
)
