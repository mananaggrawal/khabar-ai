// Thin wrapper around Supabase OAuth — replaces the Lovable Cloud auth SDK.
import { supabase } from "../supabase/client";

type SignInOptions = {
  redirect_uri?: string;
};

export const lovable = {
  auth: {
    signInWithOAuth: async (
      provider: "google" | "apple" | "microsoft",
      opts?: SignInOptions,
    ) => {
      const { error } = await supabase.auth.signInWithOAuth({
        provider,
        options: {
          redirectTo: opts?.redirect_uri ?? window.location.origin,
        },
      });
      if (error) return { error, redirected: false };
      // Supabase redirects the browser; callers can treat this as redirected.
      return { error: null, redirected: true };
    },
  },
};
