/**
 * Per-platform setup content for the /setup page — a typed content package
 * (platform metadata + code snippet templates) kept separate from rendering
 * so new platforms/snippets can be added without touching the page component.
 *
 * Snippets are generated with the real write key substituted at render time;
 * callers pass `WRITE_KEY_PLACEHOLDER` when no active key is available yet.
 */

import { getCaptureHost } from '@/lib/runtime-config'

export type SetupPlatformId = 'html' | 'web' | 'node' | 'api'

export type CodeSnippet = {
  /** Short label shown above the code block, e.g. "Install". */
  label: string
  /** Language hint shown in the code block header (not used for highlighting). */
  language: string
  code: string
}

export type SetupGuide = {
  id: SetupPlatformId
  label: string
  description: string
  snippets: (writeKey: string) => CodeSnippet[]
}

/** Shown in code snippets when the project has no active write key yet. */
export const WRITE_KEY_PLACEHOLDER = '<YOUR_WRITE_KEY>'

/** Capture host shown in snippets — from the runtime config (`/config.js`), else this origin's `/capture`. */
export const DEFAULT_API_HOST = getCaptureHost()

export const setupGuides: SetupGuide[] = [
  {
    id: 'html',
    label: 'HTML',
    description: 'Plain HTML pages, no build step — paste one script tag in your <head>.',
    snippets: (writeKey) => [
      {
        label: 'Add to <head>',
        language: 'html',
        // Generated from packages/sdk-js/loader.js via `pnpm build` (dist/loader.min.js) —
        // don't hand-edit the stub line, regenerate it instead if loader.js changes.
        code: `<script>
  "use strict";(()=>{(function(a,c){var s="${DEFAULT_API_HOST}",l=!1,p="/static/clickroom.js",n=["init","capture","identify","reset","isFeatureEnabled","getFeatureFlag","onFeatureFlags"];if(a.clickroom&&a.clickroom.__loaded__)return;var r=a.clickroom||{};r._q=r._q||[],r.__stub__=!0;function _(e){return function(){var t=Array.prototype.slice.call(arguments);r._q.push([e,t]),e==="init"&&(t[1]&&t[1].api_host&&(s=t[1].api_host),v())}}var i;for(i=0;i<n.length;i++)r[n[i]]=_(n[i]);a.clickroom=r;function f(){var e=a.clickroom,t,o,u;if(!(!e||e.__stub__))for(t=0;t<r._q.length;t++)o=r._q[t][0],u=r._q[t][1],typeof e[o]=="function"&&e[o].apply(e,u)}function v(){if(!l){l=!0;var e=c.createElement("script");e.type="text/javascript",e.async=!0,e.src=s.replace(/\\/$/,"")+p,e.onload=f;var t=c.getElementsByTagName("script")[0];t&&t.parentNode?t.parentNode.insertBefore(e,t):c.head.appendChild(e)}}})(window,document);})();

  clickroom.init('${writeKey}', { api_host: '${DEFAULT_API_HOST}', autocapture: true })
</script>`,
      },
      {
        label: 'Capture a custom event',
        language: 'html',
        code: `<script>
  clickroom.capture('signup_completed', { plan: 'pro' })
</script>`,
      },
    ],
  },
  {
    id: 'web',
    label: 'Web',
    description:
      'Add the npm package to your frontend app to autocapture clicks, pageviews, and SPA navigation, plus send custom events. No build step? Use the HTML tab instead.',
    snippets: (writeKey) => [
      {
        label: 'Install via npm',
        language: 'sh',
        code: 'pnpm add @clickroom/sdk-js',
      },
      {
        label: 'Initialize',
        language: 'ts',
        code: `import clickroom from '@clickroom/sdk-js'

clickroom.init('${writeKey}', {
  api_host: '${DEFAULT_API_HOST}',
  autocapture: true,
})`,
      },
      {
        label: 'Capture a custom event',
        language: 'ts',
        code: `clickroom.capture('signup_completed', { plan: 'pro' })`,
      },
    ],
  },
  {
    id: 'node',
    label: 'Node',
    description:
      'Use the server SDK to capture events and evaluate feature flags from backend services (Node 22+).',
    snippets: (writeKey) => [
      {
        label: 'Install',
        language: 'sh',
        code: 'pnpm add @clickroom/sdk-node',
      },
      {
        label: 'Initialize & capture',
        language: 'ts',
        code: `import { ClickroomClient } from '@clickroom/sdk-node'

const clickroom = new ClickroomClient({
  writeKey: '${writeKey}',
  host: '${DEFAULT_API_HOST}',
})

clickroom.capture({
  distinctId: user.id,
  event: 'checkout_completed',
  properties: { plan: 'pro', amount: 49 },
})`,
      },
    ],
  },
  {
    id: 'api',
    label: 'API',
    description:
      'Send events directly to the capture endpoint from any language — no SDK required.',
    snippets: (writeKey) => [
      {
        label: 'POST /v1/capture',
        language: 'sh',
        code: `curl -i ${DEFAULT_API_HOST}/v1/capture \\
  -H "Authorization: Bearer ${writeKey}" \\
  -H "Content-Type: application/json" \\
  -d '{
    "batch": [
      { "event": "signup_completed", "distinct_id": "u_123", "properties": { "plan": "pro" } }
    ]
  }'`,
      },
    ],
  },
]
