import { usePrivy, useLogin, useLogout } from "@privy-io/react-auth";

export default function ConnectButton() {
  const { ready, authenticated, user } = usePrivy();
  const { login } = useLogin(); // opens the Privy modal
  const { logout } = useLogout(); // ends the session

  if (!ready) return null; // SDK still booting

  const handleClick = () =>
    authenticated
      ? logout()
      : login({
          loginMethods: ["wallet", "email"],
        });

  return (
    <button onClick={handleClick}>
      {authenticated
        ? `Disconnect ${user?.wallet?.address?.slice(0, 6)}…`
        : "Connect"}
    </button>
  );
}
