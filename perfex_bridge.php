<?php
/**
 * Bridge de Emergencia - Superando bloqueos de CodeIgniter
 */
header('Content-Type: application/json; charset=utf-8');
define('BASEPATH', 'index.php');
define('FCPATH', __DIR__ . '/');
define('APPPATH', __DIR__ . '/application/');

if (!file_exists(__DIR__ . '/application/config/app-config.php')) {
    die(json_encode(['error' => 'No se encontró app-config.php']));
}
require_once(__DIR__ . '/application/config/app-config.php');

$secret_key = "EgyysBsXsJsKNj5HGWfF";
$received_token = $_GET['token'] ?? '';
if (empty($received_token) && isset($_SERVER['HTTP_AUTHORIZATION'])) {
    $received_token = str_ireplace('Bearer ', '', $_SERVER['HTTP_AUTHORIZATION']);
}

if (trim($received_token) !== trim($secret_key)) {
    http_response_code(401);
    die(json_encode(['error' => 'Token inválido']));
}

$conn = mysqli_connect(APP_DB_HOSTNAME, APP_DB_USERNAME, APP_DB_PASSWORD, APP_DB_NAME);
if (!$conn) die(json_encode(['error' => 'Error DB']));
mysqli_set_charset($conn, "utf8");

$action = $_GET['action'] ?? $_POST['action'] ?? '';
$response = [];

switch ($action) {
    case 'get_customer_by_phone':
        $phone = preg_replace('/\D/', '', $_GET['phone'] ?? '');
        $search = (strlen($phone) > 7) ? substr($phone, -7) : $phone;
        $sql = "SELECT c.userid as customerId, c.id as contactId, c.firstname, c.lastname, cl.company 
                FROM tblcontacts c 
                LEFT JOIN tblclients cl ON c.userid = cl.userid 
                WHERE c.phonenumber LIKE '%$search%' OR cl.phonenumber LIKE '%$search%' LIMIT 1";
        $res = mysqli_query($conn, $sql);
        $result = mysqli_fetch_assoc($res);
        $response = $result ? array_merge($result, ['found' => true]) : ['found' => false];
        break;

    case 'get_customer_by_email':
        $email = mysqli_real_escape_string($conn, trim($_GET['email'] ?? ''));
        $sql = "SELECT c.userid as customerId, c.id as contactId, c.firstname, c.lastname, cl.company 
                FROM tblcontacts c 
                LEFT JOIN tblclients cl ON c.userid = cl.userid 
                WHERE c.email = '$email' OR c.email LIKE '%$email%' LIMIT 1";
        $res = mysqli_query($conn, $sql);
        $result = mysqli_fetch_assoc($res);
        $response = $result ? array_merge($result, ['found' => true]) : ['found' => false];
        break;

    case 'get_invoices':
        $cid = intval($_GET['customer_id'] ?? 0);
        $res = mysqli_query($conn, "SELECT id, number, total, status, hash FROM tblinvoices WHERE clientid = $cid ORDER BY id DESC LIMIT 5");
        while ($row = mysqli_fetch_assoc($res)) {
            $row['view_url'] = "https://portal.gmgroup.com.co/invoice/" . $row['id'] . "/" . $row['hash'];
            $response[] = $row;
        }
        break;

    case 'get_tickets':
        $email = mysqli_real_escape_string($conn, trim($_GET['email'] ?? ''));
        $res = mysqli_query($conn, "SELECT ticketid, subject, status FROM tbltickets WHERE email = '$email' ORDER BY date DESC LIMIT 3");
        while ($row = mysqli_fetch_assoc($res)) $response[] = $row;
        break;

    case 'create_ticket':
        $post = json_decode(file_get_contents('php://input'), true);
        $subject = mysqli_real_escape_string($conn, $post['subject']);
        $message = mysqli_real_escape_string($conn, $post['message']);
        $priority = intval($post['priority'] ?? 2); // 1: Low, 2: Medium, 3: High
        $userid = intval($post['userid']);
        $contactid = intval($post['contactid']);
        $email = mysqli_real_escape_string($conn, $post['email']);
        $name = mysqli_real_escape_string($conn, $post['name']);
        $date = date('Y-m-d H:i:s');
        $ticketkey = md5(uniqid(rand(), true));

        $sql = "INSERT INTO tbltickets (userid, contactid, email, name, department, priority, status, subject, message, date, ticketkey) 
                VALUES ($userid, $contactid, '$email', '$name', 1, $priority, 1, '$subject', '$message', '$date', '$ticketkey')";
        
        if (mysqli_query($conn, $sql)) {
            $response = ['success' => true, 'ticketid' => mysqli_insert_id($conn)];
        } else {
            $response = ['success' => false, 'error' => mysqli_error($conn)];
        }
        break;
        
    // Mantener los otros casos (get_projects, get_contracts) si son necesarios
    case 'get_projects':
        $cid = intval($_GET['customer_id'] ?? 0);
        $res = mysqli_query($conn, "SELECT id, name, status FROM tblprojects WHERE clientid = $cid LIMIT 3");
        while ($row = mysqli_fetch_assoc($res)) $response[] = $row;
        break;
        
    case 'get_contracts':
        $cid = intval($_GET['customer_id'] ?? 0);
        $res = mysqli_query($conn, "SELECT id, subject, contract_value, datestart, dateend FROM tblcontracts WHERE clientid = $cid LIMIT 3");
        while ($row = mysqli_fetch_assoc($res)) $response[] = $row;
        break;
}

echo json_encode($response, JSON_UNESCAPED_UNICODE);
mysqli_close($conn);