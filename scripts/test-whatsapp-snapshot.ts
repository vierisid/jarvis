#!/usr/bin/env bun
/**
 * Test script: navigate to WhatsApp Web, open a chat, and dump snapshots.
 * Shows exactly what elements the LLM sees at each step.
 *
 * Usage: bun run scripts/test-whatsapp-snapshot.ts [chatName]
 *   chatName: optional contact/group to click open (default: first chat)
 *
 * Press Ctrl+C to stop after reviewing the output.
 */

import { BrowserController } from '../src/actions/browser/session.ts';

const browser = new BrowserController(9222, `${process.env.HOME}/.jarvis/browser/profile`);
const targetChat = process.argv[2] || ''; // optional: name of chat to open

function printElements(elements: any[]) {
  for (const el of elements) {
    const attrStr = Object.entries(el.attrs)
      .map(([k, v]) => `${k}="${v}"`)
      .join(' ');
    const textPreview = el.text ? ` text="${el.text.slice(0, 80)}"` : '';
    console.log(`  [${el.id}] <${el.tag}${textPreview}> ${attrStr}`);
  }
}

async function main() {
  console.log('Connecting to browser...');
  await browser.connect();
  console.log('Connected!\n');

  // Step 1: Navigate
  console.log('=== STEP 1: Navigate to WhatsApp Web ===');
  const nav = await browser.navigate('https://web.whatsapp.com');
  console.log(`Title: ${nav.title} | Elements: ${nav.elements.length}`);

  // Wait for full load
  console.log('Waiting 5s for full load...\n');
  await Bun.sleep(5000);

  // Step 2: Snapshot chat list
  console.log('=== STEP 2: Chat list snapshot ===');
  const chatList = await browser.snapshot();
  console.log(`Elements: ${chatList.elements.length}\n`);
  printElements(chatList.elements);

  // Step 3: Click a chat to open it
  // Find the target chat or use the first gridcell
  let chatElement: any = null;
  if (targetChat) {
    chatElement = chatList.elements.find(
      (el: any) => el.attrs.role === 'gridcell' && el.text.toLowerCase().includes(targetChat.toLowerCase())
    );
  }
  if (!chatElement) {
    chatElement = chatList.elements.find((el: any) => el.attrs.role === 'gridcell');
  }

  if (!chatElement) {
    console.log('\nNo chat entries found! Is WhatsApp logged in?');
    process.exit(1);
  }

  console.log(`\n=== STEP 3: Clicking chat: "${chatElement.text.slice(0, 60)}" (id=${chatElement.id}) ===`);
  await browser.click(chatElement.id);
  await Bun.sleep(2000);

  // Step 4: Snapshot the open conversation
  console.log('\n=== STEP 4: Open conversation snapshot ===');
  const conversation = await browser.snapshot();
  console.log(`Elements: ${conversation.elements.length}`);
  console.log(`\n--- PAGE TEXT (first 3000 chars) ---`);
  console.log(conversation.text.slice(0, 3000));
  console.log(`\n--- INTERACTIVE ELEMENTS ---`);
  printElements(conversation.elements);

  console.log('\n=== Done! Press Ctrl+C to exit ===');
  await Bun.sleep(600000);
}

main().catch(err => {
  console.error('Error:', err);
  process.exit(1);
});
