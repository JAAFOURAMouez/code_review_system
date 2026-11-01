// Offline-only typing shim for React.
// The sandbox this project was built in could not reach the npm registry, so
// @types/react was unavailable. This file declares just the React surface the
// app uses so `npm run typecheck:offline` can still check Horizon's own code.
// With dependencies installed normally, use `npm run typecheck` (real types)
// and ignore this file; it is not part of tsconfig.json.

declare module 'react' {
  export type ReactNode = any
  export type ReactElement = any
  export type CSSProperties = { [key: string]: string | number | undefined }
  export type Dispatch<A> = (value: A) => void
  export type SetStateAction<S> = S | ((prev: S) => S)
  export type PointerEvent<T = Element> = any
  export type KeyboardEvent<T = Element> = any
  export type MouseEvent<T = Element> = any
  export type ChangeEvent<T = Element> = any
  export type DragEvent<T = Element> = any
  export type FormEvent<T = Element> = any
  export interface FC<P = {}> {
    (props: P): ReactNode
  }
  export function useState<S>(init: S | (() => S)): [S, Dispatch<SetStateAction<S>>]
  export function useState<S = undefined>(): [
    S | undefined,
    Dispatch<SetStateAction<S | undefined>>,
  ]
  export function useEffect(fn: () => void | (() => void), deps?: readonly unknown[]): void
  export function useLayoutEffect(fn: () => void | (() => void), deps?: readonly unknown[]): void
  export function useMemo<T>(fn: () => T, deps: readonly unknown[]): T
  export function useCallback<T extends (...args: any[]) => any>(fn: T, deps: readonly unknown[]): T
  export function useRef<T>(init: T): { current: T }
  export function useId(): string
  export function useSyncExternalStore<T>(
    subscribe: (onChange: () => void) => () => void,
    getSnapshot: () => T,
  ): T
  export function createContext<T>(def: T): any
  export function useContext<T>(ctx: any): T
  export const StrictMode: any
  export const Fragment: any
  export class Component<P = {}, S = {}> {
    props: P & { children?: ReactNode }
    state: S
    constructor(props: P)
    setState(s: Partial<S>): void
  }
}

declare module 'react/jsx-runtime' {
  export const jsx: any
  export const jsxs: any
  export const Fragment: any
}

declare module 'react-dom/client' {
  export function createRoot(el: Element | DocumentFragment): {
    render(node: any): void
    unmount(): void
  }
}

declare namespace JSX {
  interface IntrinsicElements {
    [elemName: string]: any
  }
  interface IntrinsicAttributes {
    key?: string | number
  }
  type Element = any
  interface ElementChildrenAttribute {
    children: {}
  }
}
