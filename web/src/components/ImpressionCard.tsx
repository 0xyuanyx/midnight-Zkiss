import type { Impression } from '../state/people';

export function ImpressionCard({ name, age, gender, mbti, introduction, impression }: { name: string; age: string | number; gender: string; mbti: string; introduction: string; impression: Impression }) {
  const tags = [...impression.tags.slice(0, 2), mbti];
  return <article className="impression-card" aria-label={`${name} AI 인상 프로필${impression.example ? " 예시" : ""}`}>
    <p className="impression-eyebrow">ZKISS · FIRST IMPRESSION</p>
    <img className="impression-avatar" src={impression.image} alt={impression.example ? "AI가 생성한 프로필 이미지 예시" : "AI가 생성한 프로필 이미지"} width={96} height={96} />
    <div className="impression-analysis">
      <p className="impression-text">{impression.lines.map((line, index) => <span key={line}>{line}{index < impression.lines.length - 1 ? ' ' : ''}</span>)}</p>
    </div>
    <ul className="tags" aria-label="인상 키워드">{tags.map(tag => <li key={tag}># {tag}</li>)}</ul>
    <footer><span>{name} · {age} · {gender}</span></footer>
    <section className="profile-introduction" aria-label={`${name}님의 자기소개`}>
      <p className="profile-introduction-label">{name}님이 작성한 자기소개</p>
      <p className="profile-introduction-text">{introduction}</p>
    </section>
  </article>;
}
