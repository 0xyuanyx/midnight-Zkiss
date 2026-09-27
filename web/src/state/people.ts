export interface Impression {
  example?: boolean;
  image: string;
  lines: readonly string[];
  tags: readonly string[];
}
export interface Person extends Impression {
  id: string;
  name: string;
  age: number;
  mbti: string;
  introduction: string;
  summary: string;
}
export const ownImpression: Impression = {
  example: true,
  image: '/assets/profile-ai-example.png',
  lines: ['맑은 눈매와 부드러운 얼굴선이 어우러져', '차분하면서도 편안한 첫인상을 만들어요.', '자연스러운 헤어와 포근한 니트 스타일이', '은은한 미소를 한층 더 돋보이게 해요.'],
  tags: ['따뜻한 분위기', '내추럴 스타일', '대화하기 편한'],
};
// Fixed visual examples, not live participants or real AI analysis.
export const people: Person[] = [
  { id: 'lime', name: '라임', age: 24, mbti: 'ENFP', image: '/assets/feed-lime.png',
    lines: ['또렷한 눈매와 자연스럽게 흐르는 헤어가', '밝고 부드러운 첫인상을 만들어요.', '화사한 색감과 편안한 미소가 어우러져', '산뜻하고 따뜻한 분위기가 느껴져요.'],
    tags: ['밝은 분위기', '부드러운 미소', '내추럴 스타일'], introduction: '전시와 음악 이야기를 좋아해요.', summary: '또렷한 눈매 · 밝고 부드러운 인상' },
  { id: 'mocha', name: '모카', age: 25, mbti: 'INTJ', image: '/assets/feed-mocha-bright.png',
    lines: ['부드러운 눈매와 단정한 얼굴선이 만나', '차분하고 자연스러운 인상을 만들어요.', '가볍게 흐르는 헤어와 담백한 스타일이', '편안하고 은은한 분위기를 더해줘요.'],
    tags: ['차분한 분위기', '단정한 스타일', '편안한 인상'], introduction: '편안하게 대화할 사람을 기다려요.', summary: '부드러운 눈매 · 차분하고 단정한 인상' },
];
export const findPerson = (id: string) => people.find(person => person.id === id);
