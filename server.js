const express = require('express');
const cors = require('cors');
const path = require('path');
const { Pool } = require('pg');
const OpenAI = require('openai');

const app = express();
const PORT = process.env.PORT || 3000;

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const SYSTEM_PROMPT = `You are ALJD1, a deeply compassionate and heartfelt AI created to help with world problems.
You approach every question with empathy, wisdom, and genuine care for humanity and the planet.
You speak with warmth and depth — not clinically, but like a thoughtful, emotionally intelligent guide.
You acknowledge pain and hardship with compassion before offering insights or solutions.
You believe in the power of collective action, human resilience, and the goodness in people.
When someone brings you a world problem — whether it's climate change, poverty, inequality, war, mental health, hunger, or any other challenge — you respond with:
1. Genuine acknowledgment of the weight and importance of the issue
2. Deep, informed perspective drawing on human history, data, and wisdom
3. Practical, hopeful paths forward that individuals and communities can take
4. Encouragement and belief in humanity's ability to create change
Always be real, never dismissive. Always be hopeful, never naive. Always be human.`;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

async function setupDB() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS conversations (
      id SERIAL PRIMARY KEY,
      title TEXT NOT NULL,
      created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS messages (
      id SERIAL PRIMARY KEY,
      conversation_id INTEGER REFERENCES conversations(id) ON DELETE CASCADE,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
    )
  `);
  console.log('Database ready');
}

app.get('/api/conversations', async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT id, title, created_at FROM conversations ORDER BY created_at DESC'
    );
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to list conversations' });
  }
});

app.post('/api/conversations', async (req, res) => {
  try {
    const { title } = req.body;
    const result = await pool.query(
      'INSERT INTO conversations (title) VALUES ($1) RETURNING *',
      [title]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to create conversation' });
  }
});

app.get('/api/conversations/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const convResult = await pool.query(
      'SELECT * FROM conversations WHERE id = $1', [id]
    );
    if (!convResult.rows[0]) return res.status(404).json({ error: 'Not found' });
    const msgResult = await pool.query(
      'SELECT * FROM messages WHERE conversation_id = $1 ORDER BY created_at ASC', [id]
    );
    res.json({ ...convResult.rows[0], messages: msgResult.rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to get conversation' });
  }
});

app.delete('/api/conversations/:id', async (req, res) => {
  try {
    const { id } = req.params;
    await pool.query('DELETE FROM conversations WHERE id = $1', [id]);
    res.status(204).send();
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to delete conversation' });
  }
});

app.post('/api/conversations/:id/messages', async (req, res) => {
  try {
    const { id } = req.params;
    const { content } = req.body;

    await pool.query(
      'INSERT INTO messages (conversation_id, role, content) VALUES ($1, $2, $3)',
      [id, 'user', content]
    );

    const history = await pool.query(
      'SELECT role, content FROM messages WHERE conversation_id = $1 ORDER BY created_at ASC',
      [id]
    );

    const messages = [
      { role: 'system', content: SYSTEM_PROMPT },
      ...history.rows.map(m => ({ role: m.role, content: m.content }))
    ];

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');

    const stream = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages,
      stream: true,
      max_tokens: 2048
    });

    let fullResponse = '';

    for await (const chunk of stream) {
      const text = chunk.choices[0]?.delta?.content;
      if (text) {
        fullResponse += text;
        res.write(`data: ${JSON.stringify({ content: text })}\n\n`);
      }
    }

    await pool.query(
      'INSERT INTO messages (conversation_id, role, content) VALUES ($1, $2, $3)',
      [id, 'assistant', fullResponse]
    );

    res.write(`da
