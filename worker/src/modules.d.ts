// Binary model files are bundled as ArrayBuffer (wrangler "Data" rule).
declare module '*.zapw' {
  const data: ArrayBuffer;
  export default data;
}
