"""Install-only profile binding for BLUE Evidence v0.4.2. Does not execute models or modify old profiles."""
import json
from pathlib import Path
import sys
import runner


def build(dest=None):
    """Build and validate the BLUE Evidence v0.4.2 profile JSON without touching predecessor profiles."""
    profile = json.loads((runner.v034.HERE / 'profile-template.json').read_text(encoding='utf8'))
    profile.update(
        id=runner.PROFILE_ID,
        name=runner.PROFILE_NAME,
        version=runner.VERSION,
        instructions=runner.INSTRUCTIONS,
    )
    profile['adapter'] = {'type': 'stdio', 'executable': sys.executable, 'args': [str(runner.HERE / 'runner.py')]}
    profile['settings'].update(runner.contract_settings())
    profile['settings']['auditDirectory'] = str(runner.v033.REPO / '.local' / runner.AUDIT_DIR_NAME)
    profile['settings']['privacy'] = (
        '참고문헌 DOI/제목·저자 질의와 공개 식별자 조회만 외부 API로 나갑니다. '
        '전체 PDF, 보충자료 원문, 숨은 텍스트·주석·메타데이터 보안 감사, 도표 서브패널·축 검사, '
        '행 단위 재계산, 코드·노트북·스프레드시트 정적 대조, IMRaD 내부 일관성 감사, '
        '논증 개요와 주장-근거 대조는 로컬에서만 실행됩니다. '
        '분석 스크립트와 노트북 셀은 실행하지 않습니다. 비공개·민감 원문에는 사용하지 마세요. '
        '모델 처리에는 기존 Claude 구독을 사용합니다.'
    )
    profile['settings']['budgetDisclosure'] = (
        'Layer 0 정적 통계·원자료 재계산·코드 보충 정적 대조·IMRaD·PDF 보안·선택적 메타분석·논증 개요 Triage는 '
        '모델 호출 0회·네트워크 0회로 선행됩니다. '
        '인용 미검증 결함은 수리 호출을 최대 1회 더 쓸 수 있습니다. '
        '문서 scan/selection 호출 최대 120초, 그 외 단계 최대 70초, 내부 모델 최대 4회, 전체 adapter 150초.'
    )
    profile['settings']['limitations'] = (
        '0.4.2 실험 번들. 논증 개요와 D3/S1 힌트는 검증되지 않은 조언이며 확정 결함이 아닙니다. '
        '악마의 변호인은 각 결론이 결과에서 따라오지 않는지 먼저 따지고, 원문 그대로 인용할 수 있는 발견만 보고합니다. '
        'PDF 보안 신호는 숨은 글자·렌더 모드 3·주석·메타데이터·보충 텍스트의 명시적 주입 구문만 담습니다. '
        '인용 게이트는 제공된 세그먼트와의 문자열 일치이며 Zero-Drop 복원과 미검증 인용 강등을 유지합니다. '
        '404·미발견만으로 위조를 단정하지 마세요.'
    )
    profile['settings']['predecessor'] = 'shinick-blue-evidence-triage-v041; 기존 정의·기록은 변경하지 않음.'
    from harness import validate
    validate(profile, 'blue')
    target = Path(dest) if dest is not None else runner.HERE / 'profile.json'
    target.write_text(json.dumps(profile, ensure_ascii=False, indent=2), encoding='utf8')
    return profile


if __name__ == '__main__':
    result = build()
    print(json.dumps({'version': result['version'], 'bundleSha256': result['settings']['bundleSha256']}))
