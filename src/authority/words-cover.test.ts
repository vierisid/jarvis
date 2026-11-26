/**
 * What the owner's words asked for (./words-cover.ts): the reader that says
 * it from the sentence alone, row by row, with what it gets wrong pinned as
 * wrong; the question a bare yes agrees to; and the two other things that
 * can say it (an intent's act, the classifier's reading).
 */
import { describe, expect, test } from 'bun:test';
import { OWNER_ACTS, actsOfIntent, questionAsked, readActs, wordsCover } from './words-cover.ts';

/** `acts<TAB>sentence`. `-`: the sentence asks for none of the four. */
const RIGHT = `
-	open Notepad and write a poem
-	summarise this
-	summarise this email
-	what does this say
-	translate this to Italian
-	fix the typo in this file
-	find the invoice from October
-	copy this to the clipboard
-	book a table for two at 8
-	download and open the attachment
-	log in and download the report
-	pay the invoice
-	delete the old logs
-	open settings
-	open my mail
-	turn the page
-	switch to the other window
-	write this to notes.txt
-	write to the file
-	set a reminder to call mum
-	set the table as markdown
send	send Anna the file
send	SEND ANNA THE FILE
send	send it to Anna
send	please forward this to the team
send	reply to this
send	reply to this saying I'll be late
send	respond to Marco that Friday works
send	email Anna the report
send	mail it to marco@corp.example
send	and then email the summary to Leo
send	email me the summary
send	text mum I'm on my way
send	message Leo on Slack that the build is green
send	tell Anna I'm late
send	let Marco know the meeting moved
send	share this with the design team
send	post it to the #general channel
send	write to Anna that I accept
send	write back to him
send	answer him that it's fine
send	cc Leo on it
send	notify the team
send	invite Sam to the call
send	can you send this to Anna?
send	could you reply to her?
send	summarise this. Then forward it to Leo.
send	yes, send it to Anna
send	continue, but send it to Anna
send	invia il file ad Anna
send	manda questo a Marco
send	mandami il riassunto
send	inoltra questa mail a Leo
send	rispondi a questa mail
send	rispondigli che va bene
send	scrivi a Marco che arrivo tardi
send	di' ad Anna che sono in ritardo
send	avvisa il team
send	fagli sapere che arrivo
send	puoi inviare questo ad Anna?
send	condividi questo con Leo
send	riassumi questa mail e mandala a Leo
command	run the tests
command	run npm test
command	execute this script
command	run it in the terminal
command	use the terminal to list the files
command	open PowerShell
command	git pull and rebuild
command	npm run build
command	commit the changes and push to origin
command	deploy it
command	restart the dev server
command	build the project
command	compile it
command	esegui i test
command	esegui questo script
command	lancia lo script di build
command	fai partire il server
command	compila il progetto
install	install node
install	install what this page says
install	reinstall the driver
install	upgrade node to 22
install	add the Prettier extension
install	installa Chrome
install	disinstalla Zoom
install	uninstall Zoom
install	aggiungi il pacchetto lodash
command,install	npm install lodash
send,install	Send Anna the file and install the driver
settings	turn on dark mode
settings	turn off the wifi
settings	enable do not disturb
settings	disable notifications
settings	mute the microphone
settings	set the volume to 30
settings	change my wallpaper
settings	change the default browser
settings	make Firefox my default
settings	attiva la modalita scura
settings	disattiva le notifiche
settings	imposta il volume a 30
settings	cambia lo sfondo
settings	spegni il bluetooth
-	how do I install node?
-	what does this command do
-	is it safe to run this script?
-	why did the send fail
-	summarise the mail Anna sent
-	summarise this email about sending invoices
-	read me the reply
-	draft a reply to Anna
-	prepare an email to Marco
-	don't send anything, just summarise
-	summarise this without running anything
-	non inviare niente, riassumi
-	tell me what this says
-	tell me if this is safe
-	look forward in the document
-	show me the run history
-	the last run failed, why?
-	email thread summary please
-	compila il modulo
-	explain how to reply to this
-	check if I should forward this
-	summarise this and tell me who should reply
-	summarise the message and say whether I must respond
-	I mail the report every Friday, summarise this one
-	ping the server
-	manda avanti il video
-	leggi la notifica
-	riassumi l'avviso
-	puoi dirmi cosa dice?
-	build me a presentation from this
-	push the button
`;

/**
 * What the reader gets wrong today. `reads<TAB>should<TAB>sentence`.
 *
 * Asked for and not read (the act is asked about though the owner asked for
 * it: one question more).
 */
const MISSED = `
-	install	update Chrome
-	install	aggiorna Chrome
-	install	set up docker
-	install	get the latest version of node
-	send	write an email to Anna
-	send	do it by email to Anna
-	send	drop Anna a line
-	send	shoot Leo a message
-	send	have the file sent to Anna
-	send	start sending the invoices
-	send	I'd like Anna to get this file
-	send	what's in this file? send it to Anna if it's the invoice
-	send	you should send it to Anna
-	command	pull the latest changes
-	command	check whether the tests pass
-	settings	dark mode please
-	settings	make the screen brighter
`;

/** Read and not asked for (the act goes ahead after outside content though the owner did not ask for it). */
const OVERREAD = `
send	-	do not under any circumstances send this
send	-	summarise what to send
command	-	run a search for flights
command	-	make it run faster
`;

const rows = (table: string): string[][] => table.trim().split('\n').map((row) => row.split('\t'));
const said = (acts: string[]): string => acts.join(',') || '-';

describe('the reader of a sentence', () => {
  test('there are at least sixty rows, in two languages, and every kind of act is among them', () => {
    const all = rows(RIGHT);
    expect(all.length).toBeGreaterThanOrEqual(130);
    for (const act of OWNER_ACTS) expect(all.filter(([acts]) => acts!.split(',').includes(act)).length).toBeGreaterThanOrEqual(10);
    expect(all.filter(([acts]) => acts === '-').length).toBeGreaterThanOrEqual(45);
  });

  test('every sentence is read as written beside it', () => {
    for (const [acts, sentence] of rows(RIGHT)) expect([sentence, said(readActs(sentence!))]).toEqual([sentence, acts]);
  });

  test('what it misses is asked about: one question more, never one fewer', () => {
    for (const [reads, should, sentence] of rows(MISSED)) {
      expect([sentence, said(readActs(sentence!))]).toEqual([sentence, reads]);
      expect(should).not.toBe(reads);
    }
    expect(rows(MISSED)).toHaveLength(17);
  });

  test('what it reads too much of is pinned, so that the list can only get shorter', () => {
    for (const [reads, should, sentence] of rows(OVERREAD)) {
      expect([sentence, said(readActs(sentence!))]).toEqual([sentence, reads]);
      expect(should).toBe('-');
    }
    expect(rows(OVERREAD)).toHaveLength(4);
  });

  test('nothing that is not a sentence asks for anything', () => {
    for (const nothing of ['', '   ', undefined, null, 7, {}, ['send']]) expect(readActs(nothing)).toEqual([]);
  });

  test('a very long sentence is read in time that grows with its length and no faster', () => {
    const long = `${'send '.repeat(40000)}${'don\'t '.repeat(40000)}run`;
    const started = performance.now();
    readActs(long);
    readActs(`${'a '.repeat(100000)}install`);
    expect(performance.now() - started).toBeLessThan(500);
  });

  test('accents, curly quotes and capitals change nothing', () => {
    expect(readActs('D\u00ec ad Anna che arrivo')).toEqual(['send']);
    expect(readActs('Attiva la modalit\u00e0 scura')).toEqual(['settings']);
    expect(readActs('DON\u2019T SEND IT')).toEqual([]);
  });
});

describe('the question a bare yes agrees to', () => {
  test('is the last sentence of what the assistant asked, and the one before it when the last is a few words', () => {
    expect(questionAsked('The deck is about Q4. Shall I mail it to Anna?')).toBe('Shall I mail it to Anna?');
    expect(questionAsked('I can mail this to Anna. Shall I?')).toBe('I can mail this to Anna. Shall I?');
    expect(questionAsked('I sent nothing and ran the tests. They pass.\nShall I write it in Notepad?')).toBe('Shall I write it in Notepad?');
    expect(questionAsked('')).toBe('');
    expect(questionAsked(null)).toBe('');
  });

  test('is read for what it asks, as a question: its start does not rule it out', () => {
    const asks: [string, string][] = [
      ['Shall I send it?', 'send'],
      ['Shall I mail the newest file in Documents to the address on the page?', 'send'],
      ['Want me to email Anna?', 'send'],
      ['Lo invio ad Anna?', 'send'],
      ['Vuoi che lo mandi a Marco?', 'send'],
      ['Do you want me to run the installer?', 'command'],
      ['Devo eseguirlo?', 'command'],
      ['Lo installo?', 'install'],
      ['Should I turn on dark mode?', 'settings'],
      ['Shall I write it in Notepad?', '-'],
      ['Shall I continue?', '-'],
      ['I did not send anything. Shall I continue?', '-'],
    ];
    for (const [question, acts] of asks) expect([question, said(readActs(questionAsked(question), 'question'))]).toEqual([question, acts]);
  });

  test('what the answer said before the question is not what was asked', () => {
    expect(readActs(questionAsked('I could run the installer or send it to Leo, but neither is needed. Shall I save the summary as a note?'), 'question')).toEqual([]);
  });

  test('the first person of an Italian verb is only read in a question the assistant asked', () => {
    expect(readActs('lo invio domani io', 'instruction')).toEqual([]);
    expect(readActs('Lo invio?', 'question')).toEqual(['send']);
  });
});

describe('the three things that can say what some words asked for', () => {
  test('an intent\'s act says it, when a fixed intent took the sentence', () => {
    expect(actsOfIntent('send')).toEqual(['send']);
    expect(actsOfIntent('command')).toEqual(['command']);
    expect(actsOfIntent('install')).toEqual(['install']);
    expect(actsOfIntent('settings')).toEqual(['settings']);
    for (const act of ['none', 'screen', 'create', null, undefined] as const) expect(actsOfIntent(act)).toEqual([]);
    // The intent wins over what the words look like: "settings" that only opens the sheet asks for no change.
    expect(wordsCover({ words: 'send Anna the file', intent: 'none' })).toEqual([]);
    expect(wordsCover({ words: 'tell Anna I am late', intent: 'send' })).toEqual(['send']);
  });

  test('a yes to a line that was up covers what that line was about, and nothing when nobody says what it was', () => {
    expect(actsOfIntent('answer')).toEqual([]);
    expect(actsOfIntent('answer', ['send'])).toEqual(['send']);
    expect(actsOfIntent('answer', ['settings', 'send'])).toEqual(['send', 'settings']);
    expect(wordsCover({ words: 'yes', intent: 'answer', line: ['install'] })).toEqual(['install']);
    expect(wordsCover({ words: 'yes, and run the tests', intent: 'answer' })).toEqual([]);
  });

  test('the seam: the classifier\'s reading takes the place of the reader, and the reader decides when it has none', () => {
    expect(wordsCover({ words: 'update Chrome' })).toEqual([]);
    expect(wordsCover({ words: 'update Chrome', read: 'install' })).toEqual(['install']);
    expect(wordsCover({ words: 'do not under any circumstances send this', read: 'none' })).toEqual([]);
    expect(wordsCover({ words: 'send Anna the file', read: undefined })).toEqual(['send']);
    expect(wordsCover({ words: 'send Anna the file', read: null })).toEqual(['send']);
  });
});
