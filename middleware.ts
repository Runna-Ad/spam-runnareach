import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";

/**
 * Session refresh + auth gate.
 *
 * Runs on every matched route. Does two things:
 *   1. Refreshes the Supabase auth session cookie so the server always sees
 *      the latest token. Without this, sessions expire mid-navigation.
 *   2. Gates /dashboard/** and /settings/** — unauthenticated users are
 *      redirected to /sign-in.
 *
 * NOTE: Next 16 renamed `middleware.ts` to proxy conceptually, but the
 * `middleware.ts` filename still works. Matcher config at bottom.
 */
export async function middleware(request: NextRequest) {
  let supabaseResponse = NextResponse.next({ request });

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll();
        },
        setAll(cookiesToSet) {
          cookiesToSet.forEach(({ name, value }) => request.cookies.set(name, value));
          supabaseResponse = NextResponse.next({ request });
          cookiesToSet.forEach(({ name, value, options }) =>
            supabaseResponse.cookies.set(name, value, options),
          );
        },
      },
    },
  );

  // IMPORTANT: getUser() triggers the session refresh. Do not remove.
  const {
    data: { user },
  } = await supabase.auth.getUser();

  const { pathname } = request.nextUrl;

  const isAuthPage =
    pathname.startsWith("/sign-in") ||
    pathname.startsWith("/sign-up") ||
    pathname.startsWith("/invite");

  const isProtected =
    pathname.startsWith("/dashboard") ||
    pathname.startsWith("/discover") ||
    pathname.startsWith("/companies") ||
    pathname.startsWith("/pitches") ||
    pathname.startsWith("/funnel") ||
    pathname.startsWith("/inbox") ||
    pathname.startsWith("/analytics") ||
    pathname.startsWith("/learning") ||
    pathname.startsWith("/compliance") ||
    pathname.startsWith("/case-studies") ||
    pathname.startsWith("/icp") ||
    pathname.startsWith("/opportunities") ||
    pathname.startsWith("/settings") ||
    pathname.startsWith("/design");

  if (!user && isProtected) {
    const url = request.nextUrl.clone();
    url.pathname = "/sign-in";
    url.searchParams.set("next", pathname);
    return NextResponse.redirect(url);
  }

  if (user && isAuthPage) {
    const url = request.nextUrl.clone();
    url.pathname = "/dashboard";
    return NextResponse.redirect(url);
  }

  return supabaseResponse;
}

export const config = {
  matcher: [
    /*
     * Match all request paths except:
     * - _next/static (static files)
     * - _next/image (image optimization files)
     * - favicon.ico, robots.txt, sitemap.xml
     * - api routes that have their own auth (webhooks, cron)
     */
    "/((?!_next/static|_next/image|favicon.ico|robots.txt|sitemap.xml|api/webhooks|api/cron|api/track).*)",
  ],
};
