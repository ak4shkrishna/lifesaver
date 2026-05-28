import { createServerClient } from "@supabase/ssr";
import { SupabaseClientOptions } from "@supabase/supabase-js";
import { cookies } from "next/headers";

export const createClient = (opts?: SupabaseClientOptions<"public">) => {
  const cookieStore = cookies();
  return createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      ...opts,
      cookies: {
        getAll() {
          return cookieStore.getAll();
        },
        setAll(cookiesToSet) {
          try {
            cookiesToSet.forEach(({ name, value, options }) =>
              cookieStore.set(name, value, options)
            );
          } catch {}
        },
      },
    }
  );
};