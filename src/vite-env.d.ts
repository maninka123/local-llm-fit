/// <reference types="vite/client" />
interface ImportMetaEnv {
  readonly VITE_STATIC_HOSTING?: string;
}
declare module "*.csv?raw" {
  const content: string;
  export default content;
}
