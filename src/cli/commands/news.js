import { register } from '../router.js';
import * as core from '../../core/news.js';

register('news', {
  description: 'Fetch news headlines for a symbol via the local yf bridge',
  handler: (opts, positionals) => {
    if (!positionals[0]) throw new Error('Symbol required. Usage: tv news MELI [n]');
    return core.getNews({ symbol: positionals[0], n: positionals[1] });
  },
});
