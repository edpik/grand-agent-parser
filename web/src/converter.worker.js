import { convert } from './converter.js';

self.onmessage = async ({ data }) => {
  try {
    const result = await convert(new Uint8Array(data.buffer), data.name);
    self.postMessage({ id: data.id, result });
  } catch (error) {
    self.postMessage({ id: data.id, error: { code: error.code || 'conversion',
      message: error.message || 'Не удалось преобразовать файл.' } });
  }
};
