import { useState } from 'react';
import { Check, Copy, ExternalLink, RotateCw } from 'lucide-react';
import { useStore } from '../model/store';
import { BrandMark } from '../components/Brand';

// The browser runs on the same PC as Orrery, so its OS is the one to guide.
const WINDOWS = /Windows/i.test(navigator.userAgent);
const INSTALL_DOCS = 'https://docs.aws.amazon.com/cli/latest/userguide/getting-started-install.html';
const AWS_DIR = WINDOWS ? '%USERPROFILE%\\.aws' : '~/.aws';

function Command({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch { /* clipboard unavailable: the command is still selectable */ }
  };
  return (
    <div className="setup-cmd">
      <code>{text}</code>
      <button type="button" className="icon-btn" onClick={() => void copy()} aria-label={copied ? '복사됨' : `복사: ${text}`}>
        {copied ? <Check size={14} /> : <Copy size={14} />}
      </button>
    </div>
  );
}

/** First run on a PC with no AWS profiles: install the AWS CLI, make a profile, then check again. */
export function SetupGuide() {
  const bootstrap = useStore((s) => s.bootstrap);
  const [checking, setChecking] = useState(false);
  const [stillEmpty, setStillEmpty] = useState(false);

  const recheck = async () => {
    setChecking(true);
    try {
      await bootstrap();
      setStillEmpty(useStore.getState().setup === 'needed');
    } finally {
      setChecking(false);
    }
  };

  return (
    <div className="setup">
      <section className="setup-card" aria-labelledby="setup-title">
        <div className="load-head">
          <BrandMark size={28} />
          <div>
            <h1 id="setup-title" className="load-title">AWS 프로필이 필요합니다</h1>
            <div className="load-sub">
              이 PC의 AWS CLI 설정(<span className="mono">{AWS_DIR}</span>)에서 프로필을 찾지 못했습니다. Orrery는 그 프로필로 읽기 전용 조회만 하고, 자격증명은 이 PC 밖으로 보내지 않습니다.
            </div>
          </div>
        </div>

        <ol className="setup-steps">
          <li>
            <div className="setup-step-title">AWS CLI 설치</div>
            {WINDOWS ? (
              <>
                <p>설치 파일을 받아 실행하거나 PowerShell에서 아래 명령을 실행합니다.</p>
                <Command text="msiexec.exe /i https://awscli.amazonaws.com/AWSCLIV2.msi" />
              </>
            ) : (
              <>
                <p>설치 파일을 받아 실행합니다. Homebrew를 쓰면 아래 명령으로도 됩니다.</p>
                <Command text="brew install awscli" />
              </>
            )}
            <div className="setup-links">
              <a href={WINDOWS ? 'https://awscli.amazonaws.com/AWSCLIV2.msi' : 'https://awscli.amazonaws.com/AWSCLIV2.pkg'}>
                설치 파일 ({WINDOWS ? 'AWSCLIV2.msi' : 'AWSCLIV2.pkg'})
              </a>
              <a href={INSTALL_DOCS} target="_blank" rel="noreferrer">설치 안내 <ExternalLink size={11} /></a>
            </div>
            <p className="setup-note">설치 후 터미널을 새로 열고 <span className="mono">aws --version</span>으로 확인합니다.</p>
          </li>

          <li>
            <div className="setup-step-title">프로필 만들기</div>
            <p><b>액세스 키</b>를 받았다면: 키 ID, 비밀 키, 기본 리전(예: <span className="mono">ap-northeast-2</span>)을 차례로 입력합니다.</p>
            <Command text="aws configure" />
            <p><b>회사 SSO</b>(IAM Identity Center)를 쓴다면: SSO 시작 URL과 리전을 입력해 프로필을 만들고 로그인합니다.</p>
            <Command text="aws configure sso" />
            <p className="setup-note">로그인이 만료되면 다시 로그인합니다.</p>
            <Command text="aws sso login --profile <프로필 이름>" />
          </li>

          <li>
            <div className="setup-step-title">다시 확인</div>
            <p>Orrery를 다시 시작할 필요는 없습니다. 권한은 읽기 전용(<span className="mono">ReadOnlyAccess</span> 수준)이면 충분합니다.</p>
            <div className="load-actions">
              <button type="button" className="btn primary" onClick={() => void recheck()} disabled={checking}>
                <RotateCw size={14} className={checking ? 'spin' : ''} /> 다시 확인
              </button>
              {stillEmpty && !checking && <span className="load-hint" role="status">아직 프로필이 없습니다.</span>}
            </div>
          </li>
        </ol>
      </section>
    </div>
  );
}
