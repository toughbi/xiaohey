import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';

const dir = 'E:/code/xiaohei/.qa-live/home/threads';
const files = (await readdir(dir)).filter((name) => name.endsWith('.json'));
for (const file of files) {
  const doc = JSON.parse(await readFile(join(dir, file), 'utf8'));
  const user = doc.items.find((item) => item.kind === 'message' && item.role === 'user');
  const tools = doc.items.filter((item) => item.kind === 'tool_call').map((item) => item.name);
  const notices = doc.items
    .filter((item) => item.kind === 'notice' && item.tone !== 'info')
    .map((item) => `${item.title}: ${item.body}`.slice(0, 200));
  const assistant = [...doc.items].reverse().find((item) => item.kind === 'message' && item.role === 'assistant' && item.text.trim());
  console.log('---');
  console.log(`thread ${doc.thread.id} status=${doc.thread.status} steps=${doc.thread.steps} tokens=${doc.thread.totalTokens}`);
  console.log(`prompt: ${String(user?.text ?? '').replace(/\s+/g, ' ').slice(0, 100)}`);
  console.log(`tools: ${tools.join(', ') || '(none)'}`);
  console.log(`notices: ${notices.join(' || ') || '(none)'}`);
  console.log(`answer: ${String(assistant?.text ?? '').replace(/\s+/g, ' ').slice(0, 200)}`);
}
