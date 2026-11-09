import { readEnv } from '../_shared/whatsapp.ts';
import { handleSendBillAlerts } from './handler.ts';

const env = readEnv((k) => Deno.env.get(k));
const handler = (req: Request) => handleSendBillAlerts(req, env);
const port = Deno.env.get('MARMOOT_LOCAL_PORT');
if (port) Deno.serve({ port: Number(port) }, handler);
else Deno.serve(handler);
