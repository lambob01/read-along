import http from 'http';
import { writeFileSync } from 'fs';

// Stands in for Anki + AnkiConnect. Notes are keyed by id the way Anki does
// it: the id IS the creation timestamp in ms, which is what newestNoteId relies on.
const notes = new Map();
function addNoteRec(modelName, fields, tags) {
	const id = Date.now() * 1 + notes.size; // monotonic, ms-scale
	notes.set(id, { noteId: id, modelName, fields, tags });
	return id;
}
// Two pre-existing notes: the newest one is what "update last card" must pick.
addNoteRec('Japanese Mining', { Word: '猫', Sentence: '', SentenceAudio: '' }, ['old']);
const NEWEST = addNoteRec('Japanese Mining', { Word: '犬', Sentence: '', SentenceAudio: '' }, []);
console.log('seeded notes:', [...notes.keys()], 'newest =', NEWEST);

const models = {
	'Japanese Mining': ['Word', 'Sentence', 'SentenceAudio'],
	Basic: ['Front', 'Back']
};

http
	.createServer((req, res) => {
		const cors = {
			'Access-Control-Allow-Origin': req.headers.origin || '*',
			'Access-Control-Allow-Headers': '*',
			'Access-Control-Allow-Methods': 'POST, OPTIONS'
		};
		if (req.method === 'OPTIONS') {
			res.writeHead(204, cors);
			res.end();
			return;
		}

		let body = '';
		req.on('data', (c) => (body += c));
		req.on('end', () => {
			const { action, params } = JSON.parse(body || '{}');
			let result = null,
				error = null;
			try {
				switch (action) {
					case 'version':
						result = 6;
						break;
					case 'deckNames':
						result = ['Default', 'Mining'];
						break;
					case 'modelNames':
						result = Object.keys(models);
						break;
					case 'modelFieldNames':
						result = models[params.modelName] || [];
						break;
					case 'findNotes':
						result = [...notes.keys()];
						break;
					case 'notesInfo':
						result = params.notes.map((id) => {
							const n = notes.get(id);
							return {
								noteId: id,
								modelName: n.modelName,
								tags: n.tags,
								fields: Object.fromEntries(
									Object.entries(n.fields).map(([k, v], i) => [k, { value: v, order: i }])
								)
							};
						});
						break;
					case 'storeMediaFile': {
						writeFileSync(`ankimedia/${params.filename}`, Buffer.from(params.data, 'base64'));
						console.log(
							'  stored media:',
							params.filename,
							Buffer.from(params.data, 'base64').length,
							'bytes'
						);
						result = params.filename;
						break;
					}
					case 'updateNoteFields': {
						const n = notes.get(params.note.id);
						if (!n) throw new Error('note was not found: ' + params.note.id);
						for (const [k, v] of Object.entries(params.note.fields)) {
							if (!(k in n.fields)) throw new Error(`field "${k}" does not exist`);
							n.fields[k] = v;
						}
						console.log('  updated note', params.note.id, JSON.stringify(n.fields));
						break;
					}
					case 'addTags':
						for (const id of params.notes) notes.get(id).tags.push(...params.tags.split(' '));
						console.log('  tagged', params.notes, params.tags);
						break;
					case 'addNote': {
						const id = addNoteRec(params.note.modelName, params.note.fields, params.note.tags);
						console.log('  added note', id, JSON.stringify(params.note.fields));
						result = id;
						break;
					}
					default:
						error = 'unsupported action: ' + action;
				}
			} catch (e) {
				error = e.message;
			}
			console.log('ANKI', action, error ? 'ERROR: ' + error : 'ok');
			res.writeHead(200, { ...cors, 'Content-Type': 'application/json' });
			res.end(JSON.stringify({ result, error }));
		});
	})
	.listen(8765, () => console.log('fake AnkiConnect on 8765'));
