// Google Gemini API 연동 모듈 (클라이언트 측 안전 실행)
const GEMINI_API_ENDPOINT = 'https://generativelanguage.googleapis.com/v1beta/models';

export class GeminiAssistant {
  constructor() {
    this.apiKey = localStorage.getItem('gemini_api_key') || '';
    this.model = 'gemini-1.5-flash';
  }

  setApiKey(key) {
    this.apiKey = (key || '').trim();
    if (this.apiKey) {
      localStorage.setItem('gemini_api_key', this.apiKey);
    } else {
      localStorage.removeItem('gemini_api_key');
    }
  }

  hasApiKey() {
    return !!this.apiKey;
  }

  /**
   * 노션 노트 컨텍스트 기반 질문 답변
   */
  async ask({ question, currentNode, relatedNotes = [], allSearchDocs = [] }) {
    if (!this.apiKey) {
      throw new Error('Gemini API 키가 설정되지 않았습니다. 우측 상단 🤖 버튼을 눌러 API 키를 등록하세요.');
    }

    // 1. 컨텍스트 구성
    let contextText = '';

    if (currentNode) {
      contextText += `### 현재 열람 중인 노트: "${currentNode.title}" (폴더: ${currentNode.folder || '기본'}, 태그: ${(currentNode.tags || []).join(', ')})\n`;
      if (currentNode.content) {
        contextText += `[본문 내용]:\n${currentNode.content.slice(0, 4000)}\n\n`;
      }
    }

    // 질문과 관련된 추가 노트 발췌 (RAG)
    if (allSearchDocs.length > 0) {
      const q = question.toLowerCase();
      const scored = allSearchDocs
        .map(doc => {
          let score = 0;
          const text = (doc.text || '').toLowerCase();
          for (const word of q.split(/\s+/).filter(w => w.length >= 2)) {
            if (text.includes(word)) score += 1;
            if ((doc.title || '').toLowerCase().includes(word)) score += 3;
          }
          return { doc, score };
        })
        .filter(item => item.score > 0 && (!currentNode || item.doc.id !== currentNode.id))
        .sort((a, b) => b.score - a.score)
        .slice(0, 4);

      if (scored.length > 0) {
        contextText += `### 관련 지식 노트 참고 자료:\n`;
        for (const item of scored) {
          contextText += `• 노트 [${item.doc.title}]: ${item.doc.summary || item.doc.text.slice(0, 300)}...\n`;
        }
        contextText += '\n';
      }
    }

    const systemPrompt = `당신은 사용자의 개인 노션(Notion) 지식 저장소를 완벽히 파악하고 통찰을 제공하는 똑똑한 "지식 비서 AI"입니다.
제공된 노트 내용과 지식 연결망을 바탕으로 사용자의 질문에 한국어로 친절하고 명확하게 답변해 주세요.
노트에 언급된 내용이 있다면 인용하고, 노트 간의 연결 관계나 창의적인 아이디어가 있다면 함께 제안해 주세요.
답변은 읽기 편하도록 마크다운 서식(헤딩, 불릿, 강조)을 적절히 활용하세요.`;

    const fullPrompt = `${contextText}사용자 질문: ${question}`;

    const url = `${GEMINI_API_ENDPOINT}/${this.model}:generateContent?key=${this.apiKey}`;

    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [
          { role: 'user', parts: [{ text: fullPrompt }] }
        ],
        systemInstruction: {
          parts: [{ text: systemPrompt }]
        },
        generationConfig: {
          temperature: 0.7,
          maxOutputTokens: 2048
        }
      })
    });

    if (!res.ok) {
      const errText = await res.text();
      let errMsg = errText;
      try {
        const errJson = JSON.parse(errText);
        errMsg = errJson.error?.message || errText;
      } catch {}
      throw new Error(`Gemini API 오류 [${res.status}]: ${errMsg}`);
    }

    const data = await res.json();
    const candidate = data.candidates?.[0];
    const answer = candidate?.content?.parts?.[0]?.text || '(답변을 생성하지 못했습니다.)';
    return answer;
  }
}
