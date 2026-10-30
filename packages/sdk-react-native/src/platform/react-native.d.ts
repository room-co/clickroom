// Minimal ambient declaration for the `react-native` peer dependency — only the surface
// `./react-native.ts` actually uses. Not a full react-native type replacement; if a real
// `@types/react-native` (or react-native's own bundled types) is present in the host app, that
// wins there — this module only needs to satisfy `tsc` inside THIS package, which never installs
// react-native itself.
declare module 'react-native' {
  export const Platform: {
    OS: 'ios' | 'android' | 'windows' | 'macos' | 'web'
    Version: string | number
  }

  export const Dimensions: {
    get(which: 'window' | 'screen'): { width: number; height: number }
  }

  export const AppState: {
    currentState: string
    addEventListener(type: 'change', cb: (state: string) => void): { remove(): void }
  }
}
