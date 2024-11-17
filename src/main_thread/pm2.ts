import * as tx2 from 'tx2';
import { hotUpdate } from './index';

tx2.action('hotUpdate', async (reply) => {
    await hotUpdate();
    reply('hotUpdate done');
})
